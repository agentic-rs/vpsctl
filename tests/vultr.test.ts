import { describe, expect, test } from "bun:test";
import { AppError } from "../src/core/errors.ts";
import type { EditInstanceInput } from "../src/core/provider.ts";
import { VultrProvider } from "../src/providers/vultr/index.ts";

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

describe("Vultr validation and errors", () => {
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
        "Add the IP address reported by Vultr to this user's API Access Control as a single-host entry, then run login again.",
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
