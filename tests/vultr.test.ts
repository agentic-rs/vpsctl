import { describe, expect, test } from "bun:test";
import { AppError } from "../src/core/errors.ts";
import type {
  CreateInstanceInput,
  EditInstanceInput,
  InstanceLoginCredential,
  MachineQuery,
} from "../src/core/provider.ts";
import { VultrProvider } from "../src/providers/vultr/index.ts";
import {
  createBody,
  validateCreateDraft,
} from "../src/providers/vultr/schemas.ts";

const api_key = "test-api-key-not-for-real-requests";

function instance(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "instance-1",
    label: "web",
    region: "nrt",
    plan: "vc2-1c-1gb",
    os_id: 1743,
    status: "active",
    power_status: "running",
    server_status: "ok",
    main_ip: "192.0.2.1",
    v6_main_ip: "2001:db8::1",
    tags: ["production"],
    default_password: "private-password",
    kvm: "https://private-console.example/secret",
    ...overrides,
  };
}

function account(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: "Test Account",
    email: "admin@example.com",
    balance: -100.55,
    pending_charges: 60.25,
    last_payment_date: "2020-10-10T01:56:20+00:00",
    last_payment_amount: -1.25,
    acls: ["subscriptions_view", "billing"],
    ...overrides,
  };
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function harness(responses: Response[]): {
  provider: VultrProvider;
  requests: Request[];
} {
  const requests: Request[] = [];
  const provider = new VultrProvider({
    api_key,
    fetch: async (request) => {
      requests.push(request);
      const response = responses.shift();
      if (!response) throw new Error("Unexpected request.");
      return response;
    },
  });
  return { provider, requests };
}

const create_input = {
  region_id: "nrt",
  plan_id: "vc2-1c-1gb",
  image_id: "1743",
};

describe("Vultr account metadata", () => {
  test("fetches account metadata and only exposes documented fields", async () => {
    const { provider, requests } = harness([
      json({
        account: account({
          api_key: "private-api-key",
          internal: { api_key: "nested-private-api-key" },
        }),
        credentials: { api_key: "envelope-private-api-key" },
      }),
    ]);

    const result = await provider.getAccountMetadata();

    expect(result).toEqual({
      provider_id: "vultr",
      name: "Test Account",
      email: "admin@example.com",
      balance: -100.55,
      pending_charges: 60.25,
      last_payment_date: "2020-10-10T01:56:20+00:00",
      last_payment_amount: -1.25,
      currency: "USD",
      acls: ["subscriptions_view", "billing"],
    });
    expect(JSON.stringify(result)).not.toContain("private-api-key");
    expect(provider.info.capabilities).toContain("account_metadata");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.vultr.com/v2/account");
    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.headers.get("authorization")).toBe(`Bearer ${api_key}`);
    expect(await requests[0]?.text()).toBe("");
  });

  test("preserves signed financial amounts and fractional precision", async () => {
    const { provider } = harness([
      json({
        account: account({
          balance: -5519.11234567,
          pending_charges: -0.001234567,
          last_payment_amount: -1.000000001,
        }),
      }),
    ]);

    const result = await provider.getAccountMetadata();

    expect(result.balance).toBe(-5519.11234567);
    expect(result.pending_charges).toBe(-0.001234567);
    expect(result.last_payment_amount).toBe(-1.000000001);
  });

  test("preserves negative zero and empty payment dates from the API", async () => {
    const body = JSON.stringify({
      account: account({
        balance: 0,
        pending_charges: 0,
        last_payment_date: "",
        last_payment_amount: 0,
        acls: [],
      }),
    }).replace(/":0/g, '":-0');
    const { provider } = harness([new Response(body)]);

    const result = await provider.getAccountMetadata();

    expect(Object.is(result.balance, -0)).toBe(true);
    expect(Object.is(result.pending_charges, -0)).toBe(true);
    expect(Object.is(result.last_payment_amount, -0)).toBe(true);
    expect(result.last_payment_date).toBe("");
    expect(result.acls).toEqual([]);
  });

  test.each([
    ["missing envelope", { balance: -100.55 }],
    ["missing account fields", { account: { name: "Incomplete" } }],
    ["non-numeric balance", { account: account({ balance: "-100.55" }) }],
    ["null pending charges", { account: account({ pending_charges: null }) }],
    [
      "invalid payment amount",
      { account: account({ last_payment_amount: {} }) },
    ],
    ["invalid payment date", { account: account({ last_payment_date: null }) }],
    ["invalid email", { account: account({ email: 42 }) }],
    ["invalid permissions", { account: account({ acls: ["billing", 42] }) }],
  ])("rejects %s", async (_description, response) => {
    const { provider } = harness([json(response)]);
    await expect(provider.getAccountMetadata()).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  test("rejects infinite amounts without exposing provider data", async () => {
    const body = JSON.stringify({
      account: account({ balance: "infinite", api_key: "private-api-key" }),
    }).replace('"infinite"', "1e999");
    const { provider } = harness([new Response(body)]);
    const error = await provider
      .getAccountMetadata()
      .catch((error: unknown) => error);

    expect(error).toMatchObject({ code: "invalid_response" });
    expect(String(error)).not.toContain("private-api-key");
  });

  test("propagates account permissions errors through the existing transport", async () => {
    const { provider, requests } = harness([
      json({ error: "API key lacks billing access." }, 403),
    ]);

    await expect(provider.getAccountMetadata()).rejects.toMatchObject({
      code: "forbidden",
      status_code: 403,
    });
    expect(requests).toHaveLength(1);
  });
});

describe("Vultr instances", () => {
  test("normalizes instances and strips secrets from provider responses", async () => {
    const { provider, requests } = harness([json({ instance: instance() })]);
    const result = await provider.getInstance("instance-1");

    expect(result).toEqual({
      provider_id: "vultr",
      id: "instance-1",
      label: "web",
      region_id: "nrt",
      plan_id: "vc2-1c-1gb",
      image_id: "1743",
      status: "running",
      provider_status: "active",
      power_status: "running",
      server_status: "ok",
      public_ipv4: "192.0.2.1",
      public_ipv6: "2001:db8::1",
      tags: ["production"],
    });
    expect(JSON.stringify(result)).not.toContain("private-password");
    expect(JSON.stringify(result)).not.toContain("private-console");
    expect(JSON.stringify(provider)).not.toContain(api_key);
    expect(requests[0]?.url).toBe(
      "https://api.vultr.com/v2/instances/instance-1",
    );
    expect(requests[0]?.headers.get("authorization")).toBe(`Bearer ${api_key}`);
    expect(requests[0]?.redirect).toBe("error");
  });

  test.each([
    ["active", "running", "installingbooting", "pending"],
    ["active", "running", "installing", "pending"],
    ["pending", "running", "ok", "pending"],
    ["active", "stopped", "ok", "stopped"],
    ["active", "stopping", "ok", "pending"],
    ["new-provider-state", "running", "ok", "unknown"],
    ["active", "running", "new-server-state", "unknown"],
    ["active", "new-power-state", "ok", "unknown"],
  ] as const)(
    "maps status %s / %s / %s to %s",
    async (status, power_status, server_status, expected) => {
      const { provider } = harness([
        json({ instance: instance({ status, power_status, server_status }) }),
      ]);
      const result = await provider.getInstance("instance-1");
      expect(result.status).toBe(expected);
      expect(result.provider_status).toBe(status);
      expect(result.power_status).toBe(power_status);
      expect(result.server_status).toBe(server_status);
    },
  );

  test("maps create fields and omits unspecified options", async () => {
    const { provider, requests } = harness([
      json({ instance: instance() }, 202),
      json({ instance: instance() }, 202),
    ]);
    await provider.createInstance(create_input);
    await provider.createInstance({
      ...create_input,
      label: "web",
      hostname: "web-1",
      ssh_key_ids: ["key-1"],
      tags: [],
      enable_ipv6: false,
    });

    expect(requests[0]?.method).toBe("POST");
    expect(await requests[0]?.json()).toEqual({
      region: "nrt",
      plan: "vc2-1c-1gb",
      os_id: 1743,
    });
    expect(await requests[1]?.json()).toEqual({
      region: "nrt",
      plan: "vc2-1c-1gb",
      os_id: 1743,
      label: "web",
      hostname: "web-1",
      sshkey_id: ["key-1"],
      tags: [],
      enable_ipv6: false,
    });
  });

  test("edits labels, clears tags, and maps plan resize without a hostname", async () => {
    const { provider, requests } = harness([json({ instance: instance() })]);
    await provider.editInstance("instance-1", {
      label: "",
      tags: [],
      plan_id: "vc2-2c-4gb",
    });
    expect(requests[0]?.method).toBe("PATCH");
    expect(await requests[0]?.json()).toEqual({
      label: "",
      tags: [],
      plan: "vc2-2c-4gb",
    });
  });

  test("uses the lifecycle endpoints without request bodies", async () => {
    const { provider, requests } = harness(
      Array.from({ length: 4 }, () => new Response(null, { status: 204 })),
    );
    await provider.startInstance("instance-1");
    await provider.stopInstance("instance-1");
    await provider.rebootInstance("instance-1");
    await provider.destroyInstance("instance-1");

    expect(
      requests.map((request) => [
        request.method,
        new URL(request.url).pathname,
      ]),
    ).toEqual([
      ["POST", "/v2/instances/instance-1/start"],
      ["POST", "/v2/instances/instance-1/halt"],
      ["POST", "/v2/instances/instance-1/reboot"],
      ["DELETE", "/v2/instances/instance-1"],
    ]);
    for (const request of requests) expect(await request.text()).toBe("");
  });
});

describe("Vultr instance login credentials", () => {
  test("retrieves the default password only through the login-specific request", async () => {
    const password = "  example $'\\\"! 密碼  ";
    const { provider, requests } = harness([
      json({
        instance: instance({
          os: "Ubuntu 24.04 x64",
          user_scheme: "root",
          default_password: password,
        }),
      }),
    ]);

    expect(await provider.getInstanceLoginCredential("instance-1")).toEqual({
      user: "root",
      password,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.url).toBe(
      "https://api.vultr.com/v2/instances/instance-1",
    );
    expect(await requests[0]?.text()).toBe("");
    expect(JSON.stringify(provider)).not.toContain(password);
    expect(JSON.stringify(provider)).not.toContain(api_key);
  });

  test("associates a limited-user password with linuxuser instead of root", async () => {
    const { provider } = harness([
      json({
        instance: instance({
          os: "Debian 12 x64",
          user_scheme: "limited",
        }),
      }),
    ]);

    expect(await provider.getInstanceLoginCredential("instance-1")).toEqual({
      user: "linuxuser",
      password: "private-password",
    });
  });

  test.each([undefined, "unknown-scheme"])(
    "retains a password without inventing a username for scheme %j",
    async (user_scheme) => {
      const { provider } = harness([
        json({ instance: instance({ os: "Ubuntu 24.04 x64", user_scheme }) }),
      ]);

      expect(await provider.getInstanceLoginCredential("instance-1")).toEqual({
        password: "private-password",
      });
    },
  );

  test.each([undefined, null, ""])(
    "returns no credential when the provider omits or expires the password: %j",
    async (default_password) => {
      const { provider } = harness([
        json({ instance: instance({ user_scheme: "root", default_password }) }),
      ]);

      expect(
        await provider.getInstanceLoginCredential("instance-1"),
      ).toBeUndefined();
    },
  );

  test.each([
    { os: "Windows 2025 Standard", user_scheme: "root" },
    { os: "Windows Server 2022", user_scheme: "limited" },
  ])(
    "does not expose Windows credentials for SSH login: %j",
    async (metadata) => {
      const { provider } = harness([json({ instance: instance(metadata) })]);

      expect(
        await provider.getInstanceLoginCredential("instance-1"),
      ).toBeUndefined();
    },
  );

  test.each([
    "secret\nvalue",
    "secret\rvalue",
    "secret\0value",
    "secret\tvalue",
    "secret\u200bvalue",
    123,
  ])(
    "rejects a malformed credential without including its value: %j",
    async (default_password) => {
      const { provider } = harness([
        json({ instance: instance({ user_scheme: "root", default_password }) }),
      ]);
      const error = await provider
        .getInstanceLoginCredential("instance-1")
        .catch((error: unknown) => error);

      expect(error).toMatchObject({ code: "invalid_response" });
      expect(String(error)).not.toContain("secret");
    },
  );

  test("rejects an oversized login password without including its value", async () => {
    const { provider } = harness([
      json({
        instance: instance({
          user_scheme: "root",
          default_password: "secret".repeat(1000),
        }),
      }),
    ]);
    const error = await provider
      .getInstanceLoginCredential("instance-1")
      .catch((error: unknown) => error);

    expect(error).toMatchObject({ code: "invalid_response" });
    expect(String(error)).not.toContain("secret");
  });

  test("rejects credentials returned for a different instance", async () => {
    const { provider } = harness([
      json({ instance: instance({ id: "instance-2", user_scheme: "root" }) }),
    ]);
    const error = await provider
      .getInstanceLoginCredential("instance-1")
      .catch((error: unknown) => error);

    expect(error).toMatchObject({ code: "invalid_response" });
    expect(String(error)).not.toContain("private-password");
  });

  test("rejects unsafe instance IDs before requesting credentials", async () => {
    const { provider, requests } = harness([]);

    await expect(
      provider.getInstanceLoginCredential("../other-instance"),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(requests).toHaveLength(0);
  });

  test.each([
    [401, "authentication"],
    [403, "forbidden"],
    [404, "not_found"],
    [503, "provider_error"],
  ])(
    "preserves HTTP %i identity without exposing credential endpoint error details",
    async (status_code, code) => {
      const { provider } = harness([
        json(
          {
            error: `Credential failure: private-password ${api_key}`,
            default_password: "private-password",
          },
          status_code,
        ),
      ]);
      const error = await provider
        .getInstanceLoginCredential("instance-1")
        .catch((error: unknown) => error);

      expect(error).toMatchObject({ code, status_code });
      expect(String(error)).toContain("Unable to retrieve");
      expect(String(error)).not.toContain("private-password");
      expect(String(error)).not.toContain(api_key);
    },
  );

  test("does not expose credentials in malformed JSON or network errors", async () => {
    const malformed = harness([
      new Response('{"default_password":"private-password"', { status: 200 }),
    ]).provider;
    const network = new VultrProvider({
      api_key,
      fetch: async () => {
        throw new Error(`Network failure: private-password ${api_key}`);
      },
    });

    for (const provider of [malformed, network]) {
      const error = await provider
        .getInstanceLoginCredential("instance-1")
        .catch((error: unknown) => error);

      expect(error).toBeInstanceOf(AppError);
      expect(String(error)).not.toContain("private-password");
      expect(String(error)).not.toContain(api_key);
    }
  });

  test("keeps login credentials out of instance list, get, create, and edit results", async () => {
    const value = instance({ user_scheme: "root" });
    const { provider } = harness([
      json({ instances: [value] }),
      json({ instance: value }),
      json({ instance: value }, 202),
      json({ instance: value }),
    ]);
    const results = [
      await provider.listInstances(),
      await provider.getInstance("instance-1"),
      await provider.createInstance(create_input),
      await provider.editInstance("instance-1", { label: "renamed" }),
    ];

    expect(JSON.stringify(results)).not.toContain("default_password");
    expect(JSON.stringify(results)).not.toContain("private-password");
    expect(JSON.stringify(results)).not.toContain("user_scheme");
  });

  test.each([
    { user_scheme: "root", user: "root" },
    { user_scheme: "limited", user: "linuxuser" },
    { user_scheme: undefined, user: undefined },
    { user_scheme: "unknown-scheme", user: undefined },
  ])(
    "captures a validated deployment password from the create response for scheme $user_scheme",
    async ({ user_scheme, user }) => {
      const password = "creation-only-password";
      const { provider, requests } = harness([
        json(
          {
            instance: instance({
              os: "Ubuntu 24.04 x64",
              user_scheme,
              default_password: password,
            }),
          },
          202,
        ),
      ]);
      const captured: {
        instance_id: string;
        credential: InstanceLoginCredential;
      }[] = [];
      let returned = false;

      const result = await provider.createInstance(create_input, {
        on_login_credential: (instance_id, credential) => {
          expect(returned).toBe(false);
          captured.push({ instance_id, credential });
        },
      });
      returned = true;

      expect(captured).toEqual([
        {
          instance_id: "instance-1",
          credential: user === undefined ? { password } : { user, password },
        },
      ]);
      expect(result.id).toBe("instance-1");
      expect(JSON.stringify(result)).not.toContain(password);
      expect(JSON.stringify(result)).not.toContain("default_password");
      expect(JSON.stringify(provider)).not.toContain(password);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.method).toBe("POST");
      expect(await requests[0]?.json()).toEqual({
        region: "nrt",
        plan: "vc2-1c-1gb",
        os_id: 1743,
      });
    },
  );

  test.each([
    { name: "missing password", overrides: { default_password: undefined } },
    { name: "null password", overrides: { default_password: null } },
    { name: "empty password", overrides: { default_password: "" } },
    {
      name: "control characters",
      overrides: { default_password: "secret\nvalue" },
    },
    {
      name: "format characters",
      overrides: { default_password: "secret\u200bvalue" },
    },
    {
      name: "oversized password",
      overrides: { default_password: "secret".repeat(1000) },
    },
    { name: "invalid password type", overrides: { default_password: 123 } },
    { name: "Windows", overrides: { os: "Windows Server 2022" } },
    { name: "invalid OS metadata", overrides: { os: 123 } },
    { name: "invalid user metadata", overrides: { user_scheme: 123 } },
  ])(
    "preserves a successful deployment without password capture: $name",
    async ({ overrides }) => {
      const { provider, requests } = harness([
        json(
          { instance: instance({ user_scheme: "root", ...overrides }) },
          202,
        ),
      ]);
      const captured: InstanceLoginCredential[] = [];

      const result = await provider.createInstance(create_input, {
        on_login_credential: (_instance_id, credential) => {
          captured.push(credential);
        },
      });

      expect(result.id).toBe("instance-1");
      expect(captured).toEqual([]);
      expect(requests).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain("password");
      expect(JSON.stringify(result)).not.toContain("secret");
    },
  );

  test("validates the ordinary creation response before exposing a password", async () => {
    const { provider } = harness([
      json({ instance: instance({ region: null, user_scheme: "root" }) }, 202),
    ]);
    const captured: InstanceLoginCredential[] = [];
    const error = await provider
      .createInstance(create_input, {
        on_login_credential: (_instance_id, credential) => {
          captured.push(credential);
        },
      })
      .catch((error: unknown) => error);

    expect(error).toMatchObject({ code: "invalid_response" });
    expect(String(error)).toContain("may have succeeded");
    expect(String(error)).not.toContain("private-password");
    expect(captured).toEqual([]);
  });
});

describe("Vultr instance pricing", () => {
  test("joins a paginated plan catalog once for all listed instances", async () => {
    const { provider, requests } = harness([
      json({
        instances: [instance(), instance({ id: "instance-2" })],
        meta: { links: { next: "next-instances" } },
      }),
      json({ instances: [instance({ id: "instance-3", plan: "plan-2" })] }),
      json({
        plans: [{ id: "vc2-1c-1gb", monthly_cost: 6.125 }],
        meta: { links: { next: "next-plans" } },
      }),
      json({ plans: [{ id: "plan-2", monthly_cost: 0 }] }),
    ]);

    const result = await provider.listInstances({ include_pricing: true });

    expect(
      result.map(({ monthly_cost, currency }) => ({ monthly_cost, currency })),
    ).toEqual([
      { monthly_cost: 6.125, currency: "USD" },
      { monthly_cost: 6.125, currency: "USD" },
      { monthly_cost: 0, currency: "USD" },
    ]);
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/v2/instances",
      "/v2/instances",
      "/v2/plans",
      "/v2/plans",
    ]);
    expect(requests.every((request) => request.method === "GET")).toBe(true);
    expect(new URL(requests[3]?.url ?? "").searchParams.get("cursor")).toBe(
      "next-plans",
    );
    expect(JSON.stringify(result)).not.toContain("private-password");
    expect(JSON.stringify(result)).not.toContain("private-console");
  });

  test.each([
    ["unknown plan", []],
    ["missing price", [{ id: "vc2-1c-1gb" }]],
    ["null price", [{ id: "vc2-1c-1gb", monthly_cost: null }]],
  ])("omits unavailable pricing for %s", async (_description, plans) => {
    const { provider } = harness([
      json({ instances: [instance()] }),
      json({ plans }),
    ]);

    const [result] = await provider.listInstances({ include_pricing: true });

    expect(result).not.toHaveProperty("monthly_cost");
    expect(result).not.toHaveProperty("currency");
  });

  test("does not fetch plan pricing unless requested or for empty inventory", async () => {
    const { provider, requests } = harness([
      json({ instances: [instance()] }),
      json({ instances: [instance()] }),
      json({ instances: [] }),
      json({ instance: instance() }),
    ]);

    expect(await provider.listInstances()).toHaveLength(1);
    expect(
      await provider.listInstances({ include_pricing: false }),
    ).toHaveLength(1);
    expect(await provider.listInstances({ include_pricing: true })).toEqual([]);
    expect(await provider.getInstance("instance-1")).not.toHaveProperty(
      "monthly_cost",
    );
    expect(requests).toHaveLength(4);
    expect(requests.every((request) => !request.url.includes("/plans"))).toBe(
      true,
    );
  });

  test("omits conflicting duplicate plan prices and preserves unambiguous prices", async () => {
    const { provider } = harness([
      json({
        instances: [instance(), instance({ id: "instance-2", plan: "plan-2" })],
      }),
      json({
        plans: [
          { id: "vc2-1c-1gb", monthly_cost: 6 },
          { id: "vc2-1c-1gb", monthly_cost: 7 },
          { id: "vc2-1c-1gb", monthly_cost: 6 },
          { id: "plan-2", monthly_cost: 8 },
          { id: "plan-2", monthly_cost: 8 },
        ],
      }),
    ]);

    const result = await provider.listInstances({ include_pricing: true });

    expect(result[0]).not.toHaveProperty("monthly_cost");
    expect(result[0]).not.toHaveProperty("currency");
    expect(result[1]).toMatchObject({ monthly_cost: 8, currency: "USD" });
  });

  test.each([
    ["forbidden catalog", json({ error: `Denied ${api_key}` }, 403)],
    ["invalid catalog JSON", new Response(`invalid ${api_key}`)],
    [
      "negative price",
      json({ plans: [{ id: "vc2-1c-1gb", monthly_cost: -1 }] }),
    ],
    [
      "non-numeric price",
      json({ plans: [{ id: "vc2-1c-1gb", monthly_cost: api_key }] }),
    ],
    [
      "infinite price",
      new Response('{"plans":[{"id":"vc2-1c-1gb","monthly_cost":1e999}]}'),
    ],
  ])(
    "preserves inventory when optional pricing has %s",
    async (_description, response) => {
      const { provider } = harness([
        json({ instances: [instance()] }),
        response,
      ]);

      const result = await provider.listInstances({ include_pricing: true });

      expect(result).toHaveLength(1);
      expect(result[0]).not.toHaveProperty("monthly_cost");
      expect(result[0]).not.toHaveProperty("currency");
      expect(JSON.stringify(result)).not.toContain(api_key);
    },
  );

  test("preserves inventory when the optional pricing request fails", async () => {
    const requests: Request[] = [];
    const provider = new VultrProvider({
      api_key,
      fetch: async (request) => {
        requests.push(request);
        if (requests.length === 1) return json({ instances: [instance()] });
        throw new Error(`Network failure ${api_key}`);
      },
    });

    const result = await provider.listInstances({ include_pricing: true });

    expect(result).toHaveLength(1);
    expect(result[0]).not.toHaveProperty("monthly_cost");
    expect(requests).toHaveLength(2);
  });

  test("propagates caller cancellation during optional pricing", async () => {
    const controller = new AbortController();
    const pricing_started = Promise.withResolvers<void>();
    const requests: Request[] = [];
    const provider = new VultrProvider({
      api_key,
      fetch: async (request) => {
        requests.push(request);
        if (requests.length === 1) return json({ instances: [instance()] });
        pricing_started.resolve();
        return new Promise((_resolve, reject) => {
          request.signal.addEventListener(
            "abort",
            () => reject(new Error(`Aborted ${api_key}`)),
            { once: true },
          );
        });
      },
    });
    const result = provider
      .listInstances({
        include_pricing: true,
        signal: controller.signal,
      })
      .catch((error: unknown) => error);
    await pricing_started.promise;
    controller.abort(api_key);

    const error = await result;
    expect(error).toMatchObject({
      code: "cancelled",
      message: "Operation cancelled.",
    });
    expect(String(error)).not.toContain(api_key);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.signal.aborted).toBe(true);
  });
});

describe("Vultr pagination and catalogs", () => {
  test("encodes next as an opaque cursor and keeps requests on the fixed API origin", async () => {
    const cursor =
      "https://another-origin.example/page?token=secret&cursor=next";
    const { provider, requests } = harness([
      json({ instances: [instance()], meta: { links: { next: cursor } } }),
      json({
        instances: [instance({ id: "instance-2" })],
        meta: { links: { next: "" } },
      }),
    ]);
    expect((await provider.listInstances()).map((value) => value.id)).toEqual([
      "instance-1",
      "instance-2",
    ]);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      const url = new URL(request.url);
      expect(url.origin).toBe("https://api.vultr.com");
      expect(url.pathname).toBe("/v2/instances");
      expect(url.searchParams.get("per_page")).toBe("500");
    }
    expect(new URL(requests[1]?.url ?? "").searchParams.get("cursor")).toBe(
      cursor,
    );
  });

  test("rejects a repeated pagination cursor", async () => {
    const { provider, requests } = harness([
      json({ instances: [], meta: { links: { next: "repeat" } } }),
      json({ instances: [], meta: { links: { next: "repeat" } } }),
    ]);
    await expect(provider.listInstances()).rejects.toMatchObject({
      code: "invalid_response",
    });
    expect(requests).toHaveLength(2);
  });

  test("normalizes region, plan, image, and SSH key catalogs", async () => {
    const { provider, requests } = harness([
      json({ regions: [{ id: "nrt", city: "Tokyo", country: "JP" }] }),
      json({
        plans: [
          {
            id: "plan-1",
            vcpu_count: 2,
            ram: 4096,
            disk: 80,
            monthly_cost: 24,
            locations: ["nrt"],
          },
          {
            id: "plan-2",
            vcpu_count: 1,
            ram: 1024,
            disk: 25,
            monthly_cost: 6,
            locations: ["ewr"],
          },
        ],
      }),
      json({
        os: [{ id: 1743, name: "Debian 12", arch: "x64", family: "debian" }],
      }),
      json({
        ssh_keys: [
          { id: "key-1", name: "laptop", ssh_key: "excluded-public-key" },
        ],
      }),
    ]);
    expect(await provider.listRegions()).toEqual([
      { id: "nrt", name: "Tokyo", country: "JP" },
    ]);
    expect(await provider.listPlans("nrt")).toEqual([
      {
        id: "plan-1",
        vcpu_count: 2,
        memory_mb: 4096,
        disk_gb: 80,
        monthly_cost: 24,
        currency: "USD",
        region_ids: ["nrt"],
      },
    ]);
    expect(await provider.listImages()).toEqual([
      { id: "1743", name: "Debian 12", architecture: "x64", family: "debian" },
    ]);
    expect(await provider.listSshKeys()).toEqual([
      { id: "key-1", name: "laptop" },
    ]);
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/v2/regions",
      "/v2/plans",
      "/v2/os",
      "/v2/ssh-keys",
    ]);
  });
});

function machinePlan(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "plan-1",
    type: "vc2",
    name: "Example plan",
    vcpu_count: 2,
    ram: 4096,
    disk: 80,
    monthly_cost: 12,
    locations: ["nrt", "ewr"],
    ...overrides,
  };
}

function metalPlan(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "metal-plan-1",
    cpu_count: 4,
    cpu_threads: 8,
    cpu_model: "Example CPU",
    ram: 32768,
    disk: 480,
    disk_count: 1,
    monthly_cost: 120,
    locations: ["nrt"],
    type: "SSD",
    ...overrides,
  };
}

describe("Vultr machine discovery", () => {
  test("classifies explicit provider types without inferring from plan IDs", async () => {
    const types = [
      "vc2",
      "vhf",
      "vhp",
      "vdc",
      "voc",
      "voc-g",
      "voc-c",
      "voc-m",
      "voc-s",
      "vx1",
      "vcg",
    ];
    const { provider, requests } = harness([
      json({
        plans: [
          ...types.map((type, index) =>
            machinePlan({ id: `opaque-${index}`, type }),
          ),
          machinePlan({ id: "vc2-looking-id", type: "future-unknown" }),
          machinePlan({ id: "vhf-looking-id", type: undefined }),
        ],
      }),
      json({ plans_metal: [metalPlan({ id: "opaque-metal" })] }),
    ]);

    const result = await provider.listMachines();
    expect(result.map((item) => [item.id, item.type])).toEqual([
      ["opaque-0", "shared_cpu"],
      ["opaque-1", "shared_cpu"],
      ["opaque-2", "shared_cpu"],
      ["opaque-3", "dedicated_cpu"],
      ["opaque-4", "dedicated_cpu"],
      ["opaque-5", "dedicated_cpu"],
      ["opaque-6", "dedicated_cpu"],
      ["opaque-7", "dedicated_cpu"],
      ["opaque-8", "dedicated_cpu"],
      ["opaque-9", "dedicated_cpu"],
      ["opaque-10", "gpu"],
      ["opaque-metal", "bare_metal"],
    ]);
    expect(result.every((item) => item.availability === "unknown")).toBe(true);
    expect(result.every((item) => item.source === "plan")).toBe(true);
    expect(provider.info.capabilities).toContain("machines");
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/v2/plans",
      "/v2/plans-metal",
    ]);
    expect(requests.every((request) => request.method === "GET")).toBe(true);
  });

  test("normalizes CPU and GPU specifications without copying extra fields", async () => {
    const { provider } = harness([
      json({
        plans: [
          machinePlan({
            id: "gpu-plan",
            type: "vcg",
            gpu_type: "Example GPU",
            gpu_vram_gb: 24,
            internal: "private-provider-field",
          }),
        ],
      }),
    ]);
    expect(await provider.listMachines({ type: "gpu" })).toEqual([
      {
        provider_id: "vultr",
        id: "gpu-plan",
        name: "Example plan",
        type: "gpu",
        source: "plan",
        availability: "unknown",
        region_ids: ["nrt", "ewr"],
        vcpu_count: 2,
        memory_mb: 4096,
        disk_gb: 80,
        monthly_cost: 12,
        currency: "USD",
        gpu_name: "Example GPU",
        gpu_memory_gb: 24,
      },
    ]);
  });

  test("normalizes bare metal separately from virtual dedicated CPU plans", async () => {
    const { provider, requests } = harness([
      json({ plans_metal: [metalPlan()] }),
    ]);
    const [result] = await provider.listMachines({ type: "bare_metal" });
    expect(result).toMatchObject({
      provider_id: "vultr",
      id: "metal-plan-1",
      name: "Example CPU",
      type: "bare_metal",
      source: "plan",
      availability: "unknown",
      region_ids: ["nrt"],
      cpu_count: 4,
      cpu_threads: 8,
      cpu_model: "Example CPU",
      memory_mb: 32768,
      disk_gb: 480,
      disk_size_gb: 480,
      disk_count: 1,
      monthly_cost: 120,
      currency: "USD",
    });
    expect(result).not.toHaveProperty("vcpu_count");
    expect(new URL(requests[0]?.url ?? "").pathname).toBe("/v2/plans-metal");
  });

  test("preserves physical drive configuration without assuming RAID capacity", async () => {
    const { provider } = harness([
      json({
        plans_metal: [
          metalPlan({ id: "multi-drive", disk: "480", disk_count: 2 }),
          metalPlan({ id: "unknown-drive-count", disk_count: undefined }),
        ],
      }),
    ]);
    const result = await provider.listMachines({ type: "bare_metal" });
    expect(result[0]).toMatchObject({ disk_size_gb: 480, disk_count: 2 });
    expect(result[0]).not.toHaveProperty("disk_gb");
    expect(result[1]).toMatchObject({ disk_size_gb: 480 });
    expect(result[1]).not.toHaveProperty("disk_gb");
    expect(result[1]).not.toHaveProperty("disk_count");
  });

  test("does not match a disk capacity filter when usable metal capacity is unknown", async () => {
    const { provider } = harness([
      json({
        plans_metal: [
          metalPlan({ id: "multi-drive", disk_count: 2 }),
          metalPlan({ id: "single-drive" }),
        ],
      }),
    ]);
    expect(
      (await provider.listMachines({ type: "bare_metal", disk_gb: 480 })).map(
        (item) => item.id,
      ),
    ).toEqual(["single-drive"]);
  });

  test.each(["", "480 GB", "-1", "9007199254740992"])(
    "rejects unsafe metal disk size %j",
    async (disk) => {
      const { provider } = harness([
        json({ plans_metal: [metalPlan({ disk })] }),
      ]);
      await expect(
        provider.listMachines({ type: "bare_metal" }),
      ).rejects.toMatchObject({ code: "invalid_response" });
    },
  );

  test("checks current regional stock and preserves supported but sold-out plans", async () => {
    const { provider, requests } = harness([
      json({
        plans: [
          machinePlan({ id: "available" }),
          machinePlan({ id: "sold-out" }),
          machinePlan({ id: "elsewhere", locations: ["ewr"] }),
          machinePlan({ id: "live-only", locations: [] }),
        ],
      }),
      json({ available_plans: ["available", "live-only"] }),
    ]);
    expect(
      (
        await provider.listMachines({ type: "shared_cpu", region_id: "nrt" })
      ).map((item) => [item.id, item.availability, item.region_ids]),
    ).toEqual([
      ["available", "available", ["nrt"]],
      ["sold-out", "unavailable", ["nrt"]],
      ["live-only", "available", ["nrt"]],
    ]);
    expect(requests[1]?.url).toBe(
      "https://api.vultr.com/v2/regions/nrt/availability?type=all",
    );
  });

  test("filters unavailable regional plans before applying the result limit", async () => {
    const { provider } = harness([
      json({
        plans: [
          machinePlan({ id: "sold-out" }),
          machinePlan({ id: "small", disk: 10 }),
          machinePlan({ id: "match" }),
          machinePlan({ id: "extra" }),
        ],
      }),
      json({ available_plans: ["small", "match", "extra"] }),
    ]);
    const result = await provider.listMachines({
      type: "shared_cpu",
      region_id: "nrt",
      disk_gb: 80,
      available_only: true,
      limit: 1,
    });
    expect(result.map((item) => item.id)).toEqual(["match"]);
  });

  test("paginates the bare-metal catalog using its own envelope", async () => {
    const { provider, requests } = harness([
      json({
        plans_metal: [metalPlan()],
        meta: { links: { next: "metal-page-2" } },
      }),
      json({ plans_metal: [metalPlan({ id: "metal-plan-2" })] }),
    ]);
    expect(
      (await provider.listMachines({ type: "bare_metal" })).map(
        (item) => item.id,
      ),
    ).toEqual(["metal-plan-1", "metal-plan-2"]);
    expect(new URL(requests[1]?.url ?? "").searchParams.get("cursor")).toBe(
      "metal-page-2",
    );
  });

  test.each([
    ["shared_cpu", "plans"],
    ["bare_metal", "plans_metal"],
  ] as const)("rejects malformed %s specifications", async (type, field) => {
    const { provider } = harness([
      json({ [field]: [{ id: "private-provider-field", type: "vc2" }] }),
    ]);
    const error = await provider
      .listMachines({ type })
      .catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "invalid_response" });
    expect(String(error)).not.toContain("private-provider-field");
  });

  test("does not silently turn stock-check failures into availability", async () => {
    const { provider } = harness([
      json({ plans: [machinePlan()] }),
      json({ error: "Unavailable stock service" }, 503),
    ]);
    await expect(
      provider.listMachines({ type: "shared_cpu", region_id: "nrt" }),
    ).rejects.toMatchObject({ code: "provider_error" });
  });

  test("rejects malformed stock responses", async () => {
    const { provider } = harness([
      json({ plans_metal: [metalPlan()] }),
      json({ available_plans: "metal-plan-1" }),
    ]);
    await expect(
      provider.listMachines({ type: "bare_metal", region_id: "nrt" }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  test.each([
    { type: "unknown" },
    { type: "shared_cpu", region_id: "../nrt" },
    { type: "shared_cpu", available_only: true },
    { type: "shared_cpu", limit: 101 },
    { type: "shared_cpu", disk_gb: -1 },
  ])("validates discovery inputs before any request: %j", async (query) => {
    const { provider, requests } = harness([]);
    await expect(
      provider.listMachines(query as MachineQuery),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(requests).toHaveLength(0);
  });
});

describe("Vultr read cancellation", () => {
  test.each(["getAccountMetadata", "listInstances"] as const)(
    "%s rejects an already cancelled signal before fetching",
    async (method) => {
      const { provider, requests } = harness([]);
      const controller = new AbortController();
      controller.abort(api_key);

      await expect(
        provider[method]({ signal: controller.signal }),
      ).rejects.toMatchObject({
        code: "cancelled",
        message: "Operation cancelled.",
      });
      expect(requests).toHaveLength(0);
    },
  );

  test.each(["getAccountMetadata", "listInstances"] as const)(
    "%s aborts an in-flight fetch without exposing its rejection or retry advice",
    async (method) => {
      const requests: Request[] = [];
      const controller = new AbortController();
      const provider = new VultrProvider({
        api_key,
        fetch: (request) => {
          requests.push(request);
          return new Promise((_resolve, reject) => {
            request.signal.addEventListener(
              "abort",
              () => reject(new Error(`Aborted with secret ${api_key}`)),
              { once: true },
            );
          });
        },
      });
      const result = provider[method]({ signal: controller.signal }).catch(
        (error: unknown) => error,
      );
      controller.abort(api_key);
      const error = await result;

      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({
        code: "cancelled",
        message: "Operation cancelled.",
      });
      expect(String(error)).not.toContain(api_key);
      expect(String(error)).not.toContain("retry");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.signal.aborted).toBe(true);
    },
  );

  test.each([200, 401])(
    "reports cancellation while parsing an HTTP %i body",
    async (status_code) => {
      const controller = new AbortController();
      const parsing = Promise.withResolvers<void>();
      const provider = new VultrProvider({
        api_key,
        fetch: async (request) => {
          const response = new Response(null, { status: status_code });
          Object.defineProperty(response, "json", {
            value: () => {
              parsing.resolve();
              return new Promise((_resolve, reject) => {
                request.signal.addEventListener(
                  "abort",
                  () => reject(new Error(`Body failure ${api_key}`)),
                  { once: true },
                );
              });
            },
          });
          return response;
        },
      });
      const result = provider
        .getAccountMetadata({ signal: controller.signal })
        .catch((error: unknown) => error);
      await parsing.promise;
      controller.abort(api_key);

      const error = await result;
      expect(error).toMatchObject({
        code: "cancelled",
        message: "Operation cancelled.",
      });
      expect(String(error)).not.toContain(api_key);
    },
  );

  test("stops pagination when cancelled as a page finishes parsing", async () => {
    const controller = new AbortController();
    const requests: Request[] = [];
    const provider = new VultrProvider({
      api_key,
      fetch: async (request) => {
        requests.push(request);
        const response = json({
          instances: [instance()],
          meta: { links: { next: "second-page" } },
        });
        const parse = response.json.bind(response);
        Object.defineProperty(response, "json", {
          value: async () => {
            const page: unknown = await parse();
            controller.abort();
            return page;
          },
        });
        return response;
      },
    });

    await expect(
      provider.listInstances({ signal: controller.signal }),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(requests).toHaveLength(1);
  });

  test("forwards cancellation to later pages without requesting another page", async () => {
    const controller = new AbortController();
    const second_page = Promise.withResolvers<void>();
    const requests: Request[] = [];
    const provider = new VultrProvider({
      api_key,
      fetch: async (request) => {
        requests.push(request);
        if (requests.length === 1) {
          return json({
            instances: [instance()],
            meta: { links: { next: "second-page" } },
          });
        }
        second_page.resolve();
        return new Promise((_resolve, reject) => {
          request.signal.addEventListener(
            "abort",
            () => reject(new Error(`Aborted ${api_key}`)),
            { once: true },
          );
        });
      },
    });
    const result = provider
      .listInstances({ signal: controller.signal })
      .catch((error: unknown) => error);
    await second_page.promise;
    controller.abort();

    expect(await result).toMatchObject({ code: "cancelled" });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.signal.aborted).toBe(true);
  });

  test.each(["success", "http_error", "invalid_json", "network_error"])(
    "removes the external abort listener after %s",
    async (outcome) => {
      const controller = new AbortController();
      const requests: Request[] = [];
      const provider = new VultrProvider({
        api_key,
        fetch: async (request) => {
          requests.push(request);
          if (outcome === "network_error") throw new Error("Network failure");
          if (outcome === "http_error") return json({ error: "Denied" }, 401);
          if (outcome === "invalid_json") return new Response("invalid");
          return json({ account: account() });
        },
      });
      await provider
        .getAccountMetadata({ signal: controller.signal })
        .catch(() => undefined);
      controller.abort();

      expect(requests).toHaveLength(1);
      expect(requests[0]?.signal.aborted).toBe(false);
    },
  );

  test("keeps a read timeout separate from caller cancellation and never retries", async () => {
    const controller = new AbortController();
    let request_count = 0;
    const provider = new VultrProvider({
      api_key,
      timeout_ms: 5,
      fetch: (request) => {
        request_count += 1;
        return new Promise((_resolve, reject) => {
          request.signal.addEventListener(
            "abort",
            () => reject(new Error(`Timed out ${api_key}`)),
            { once: true },
          );
        });
      },
    });
    const error = await provider
      .getAccountMetadata({ signal: controller.signal })
      .catch((error: unknown) => error);

    expect(error).toMatchObject({ code: "network_error" });
    expect(String(error)).toContain("timed out");
    expect(String(error)).not.toContain(api_key);
    expect(String(error)).not.toContain("may have succeeded");
    expect(controller.signal.aborted).toBe(false);
    expect(request_count).toBe(1);
  });
});

describe("Vultr validation and errors", () => {
  test("validates supplied create fields while allowing required fields to be prompted", () => {
    for (const input of [{}, { region_id: "nrt" }, { image_id: "1743" }]) {
      expect(() => validateCreateDraft(input)).not.toThrow();
      expect(() => createBody(input)).toThrow(
        expect.objectContaining({ code: "invalid_input" }),
      );
    }
    expect(() => validateCreateDraft(create_input)).not.toThrow();
  });

  test.each([
    { region_id: "../region" },
    { plan_id: "" },
    { image_id: "0" },
    { ssh_key_ids: ["../key"] },
    { tags: [1] },
    { enable_ipv6: "true" },
    { offer_id: "123" },
    { disk_gb: 20 },
    { unexpected: true },
  ])("rejects invalid or foreign draft fields %j", (input) => {
    expect(() => validateCreateDraft(input as CreateInstanceInput)).toThrow(
      expect.objectContaining({ code: "invalid_input" }),
    );
  });

  test.each(["", ".", "..", "a/../b", "a/b", "a\\b", "a b", "a\nb", "a%2Fb"])(
    "rejects unsafe instance ID %j before sending a request",
    async (id) => {
      const { provider, requests } = harness([]);
      await expect(provider.getInstance(id)).rejects.toMatchObject({
        code: "invalid_input",
      });
      expect(requests).toHaveLength(0);
    },
  );

  test.each(["0", "-1", "1.5", "NaN", "01", "1e3", "9007199254740992"])(
    "rejects non-positive or unsafe numeric image ID %j",
    async (image_id) => {
      const { provider, requests } = harness([]);
      await expect(
        provider.createInstance({ ...create_input, image_id }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(requests).toHaveLength(0);
    },
  );

  test("validates create and edit fields and catalog filters before fetching", async () => {
    const { provider, requests } = harness([]);
    await expect(
      provider.createInstance({ ...create_input, ssh_key_ids: ["../key"] }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(provider.editInstance("instance-1", {})).rejects.toMatchObject(
      { code: "invalid_input" },
    );
    await expect(
      provider.editInstance("instance-1", {
        label: undefined,
      } as unknown as EditInstanceInput),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      provider.editInstance("instance-1", {
        hostname: "reinstall-risk",
      } as EditInstanceInput),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(provider.listPlans("../nrt")).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(requests).toHaveLength(0);
  });

  test.each([
    [400, "invalid_input"],
    [401, "authentication"],
    [403, "forbidden"],
    [404, "not_found"],
    [409, "conflict"],
    [422, "invalid_input"],
    [429, "rate_limit"],
    [503, "provider_error"],
  ])(
    "maps HTTP %i to %s without leaking provider response secrets",
    async (status_code, code) => {
      const { provider, requests } = harness([
        json({ error: `Sensitive ${api_key}` }, status_code),
      ]);
      const error = await provider
        .getInstance("instance-1")
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ code, status_code });
      expect(String(error)).not.toContain(api_key);
      expect(requests).toHaveLength(1);
    },
  );

  test.each([401, 403])(
    "identifies an unauthorized IP address in HTTP %i as an access-control rejection",
    async (status_code) => {
      const reason = "Unauthorized IP address: 198.51.100.42";
      const { provider, requests } = harness([
        json({ error: reason }, status_code),
      ]);
      const error = await provider
        .listInstances()
        .catch((error: unknown) => error);

      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ code: "forbidden", status_code });
      expect(String(error)).toContain(reason);
      expect(String(error)).toContain(
        "Add the IP address reported by Vultr to this user's API Access Control as a single-host entry, then run auth login again.",
      );
      expect(String(error)).not.toContain("Finalize Key Generation");
      expect(String(error)).not.toContain("new key");
      expect(String(error)).not.toContain("complete active API key");
      expect(requests).toHaveLength(1);
    },
  );

  test("recognizes IP access-control errors with surrounding whitespace and mixed case", async () => {
    const { provider, requests } = harness([
      json({ error: "  UnAuThOrIzEd IP AdDrEsS : 198.51.100.42  " }, 401),
    ]);
    const error = await provider
      .listInstances()
      .catch((error: unknown) => error);

    expect(error).toMatchObject({ code: "forbidden", status_code: 401 });
    expect(String(error)).toContain("198.51.100.42");
    expect(String(error)).toContain("API Access Control");
    expect(requests).toHaveLength(1);
  });

  test.each(["The API key has expired.", "Invalid API key."])(
    "retains authentication guidance for an unrelated HTTP 401 reason: %s",
    async (reason) => {
      const { provider, requests } = harness([json({ error: reason }, 401)]);
      const error = await provider
        .listInstances()
        .catch((error: unknown) => error);

      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ code: "authentication", status_code: 401 });
      expect(String(error)).toContain(reason);
      expect(String(error)).toContain("complete active API key");
      expect(String(error)).not.toContain("API Access Control");
      expect(requests).toHaveLength(1);
    },
  );

  test("redacts credentials echoed in provider error details", async () => {
    const other_token = "another-sensitive-bearer-token";
    const { provider } = harness([
      json(
        {
          error: `Rejected ${api_key}; Authorization: Bearer ${api_key}; fallback Bearer ${other_token}`,
          private_metadata: "unrelated-private-provider-field",
        },
        401,
      ),
    ]);
    const error = await provider
      .listInstances()
      .catch((error: unknown) => error);

    expect(error).toMatchObject({ code: "authentication", status_code: 401 });
    expect(String(error)).toContain("Rejected");
    expect(String(error)).not.toContain(api_key);
    expect(String(error)).not.toContain(other_token);
    expect(String(error)).not.toContain("unrelated-private-provider-field");
  });

  test.each([
    ["non-JSON", "<html>private-provider-page</html>"],
    ["malformed JSON", '{"error":"private-provider-page"'],
    [
      "absent error field",
      JSON.stringify({ message: "private-provider-page" }),
    ],
    [
      "non-string error field",
      JSON.stringify({ error: { secret: "private-provider-page" } }),
    ],
    ["empty error field", JSON.stringify({ error: "" })],
    ["JSON array", JSON.stringify([{ error: "private-provider-page" }])],
    ["JSON null", "null"],
  ])(
    "retains HTTP error identity for %s bodies",
    async (_description, body) => {
      const { provider } = harness([new Response(body, { status: 401 })]);
      const error = await provider
        .listInstances()
        .catch((error: unknown) => error);

      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ code: "authentication", status_code: 401 });
      expect(String(error)).toContain("HTTP 401");
      expect(String(error)).not.toContain("private-provider-page");
    },
  );

  test("keeps provider error details bounded and safe for terminal output", async () => {
    const { provider } = harness([
      json({ error: `Denied\n\r\t\u001b[31m ${"x".repeat(5_000)}` }, 403),
    ]);
    const error = await provider
      .listInstances()
      .catch((error: unknown) => error);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: "forbidden", status_code: 403 });
    expect(String(error)).toContain("Denied");
    expect(
      Array.from(String(error)).every((character) => {
        const code = character.charCodeAt(0);
        return code >= 32 && code !== 127;
      }),
    ).toBe(true);
    expect(String(error).length).toBeLessThan(1_000);
  });

  test("rejects malformed provider data and invalid JSON", async () => {
    const { provider } = harness([
      json({ instance: { id: "incomplete" } }),
      new Response("not JSON", { status: 200 }),
      json({ instances: [], meta: { links: { next: 123 } } }),
    ]);
    await expect(provider.getInstance("instance-1")).rejects.toMatchObject({
      code: "invalid_response",
    });
    await expect(provider.getInstance("instance-1")).rejects.toMatchObject({
      code: "invalid_response",
    });
    await expect(provider.listInstances()).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  test("does not retry ambiguous mutations or expose network error secrets", async () => {
    let request_count = 0;
    const provider = new VultrProvider({
      api_key,
      fetch: async () => {
        request_count += 1;
        throw new Error(`Network failure containing ${api_key}`);
      },
    });
    const error = await provider
      .createInstance(create_input)
      .catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "network_error" });
    expect(String(error)).toContain("may have succeeded");
    expect(String(error)).toContain("before retrying");
    expect(String(error)).not.toContain(api_key);
    expect(request_count).toBe(1);
  });

  test("marks malformed successful mutation responses as ambiguous without retrying", async () => {
    const { provider, requests } = harness([
      json({ instance: { id: "incomplete" } }, 202),
      json({ instance: { id: "incomplete" } }),
      json({ instance: { id: "incomplete" } }),
    ]);
    const create_error = await provider
      .createInstance(create_input)
      .catch((error: unknown) => error);
    const edit_error = await provider
      .editInstance("instance-1", { label: "renamed" })
      .catch((error: unknown) => error);
    const read_error = await provider
      .getInstance("instance-1")
      .catch((error: unknown) => error);

    for (const error of [create_error, edit_error]) {
      expect(error).toMatchObject({ code: "invalid_response" });
      expect(String(error)).toContain("may have succeeded");
      expect(String(error)).toContain("before retrying");
    }
    expect(String(read_error)).not.toContain("may have succeeded");
    expect(requests).toHaveLength(3);
  });

  test("aborts timed-out requests and advises checking mutation results", async () => {
    const provider = new VultrProvider({
      api_key,
      timeout_ms: 5,
      fetch: (request) =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        }),
    });
    const error = await provider
      .startInstance("instance-1")
      .catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "network_error" });
    expect(String(error)).toContain("timed out");
    expect(String(error)).toContain("may have succeeded");
  });

  test("warns that a mutation returning a server error might have succeeded", async () => {
    const { provider, requests } = harness([json({ error: "unknown" }, 500)]);
    const error = await provider
      .destroyInstance("instance-1")
      .catch((error: unknown) => error);
    expect(String(error)).toContain("before retrying");
    expect(requests).toHaveLength(1);
  });

  test("validates credentials and timeout without disclosing the credential", () => {
    expect(() => new VultrProvider({ api_key: "" })).toThrow(AppError);
    expect(() => new VultrProvider({ api_key: `${api_key}\n` })).toThrow(
      AppError,
    );
    expect(() => new VultrProvider({ api_key, timeout_ms: 0 })).toThrow(
      AppError,
    );
    expect(
      () =>
        new VultrProvider({ api_key, timeout_ms: Number.POSITIVE_INFINITY }),
    ).toThrow(AppError);
  });
});
