import { describe, expect, test } from "bun:test";
import type {
  CreateInstanceInput,
  EditInstanceInput,
  OfferQuery,
} from "../src/core/provider.ts";
import {
  VastProvider,
  validateCreateInput,
  validateEditInput,
} from "../src/providers/vast/index.ts";

const api_key = "synthetic-vast-api-key";
const create_input: CreateInstanceInput = {
  offer_id: "123",
  image_id: "example/workload:latest",
  disk_gb: 20,
};

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function instance(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 456,
    label: "worker",
    actual_status: "running",
    intended_status: "running",
    cur_state: "running",
    image_uuid: "example/workload:latest",
    public_ipaddr: "192.0.2.10",
    dph_total: 0.25,
    gpu_name: "Example GPU",
    num_gpus: 2,
    gpu_ram: 24000,
    ssh_host: "ssh.example.invalid",
    ssh_port: 22000,
    jupyter_token: "private-jupyter-token",
    extra_env: [["TOKEN", "private-env-token"]],
    ...overrides,
  };
}

function offer(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 123,
    gpu_name: "Example GPU",
    num_gpus: 2,
    dph_total: 0.25,
    cpu_cores_effective: 8.5,
    cpu_ram: 32000,
    disk_space: 100,
    gpu_ram: 24000,
    reliability2: 0.99,
    ...overrides,
  };
}

function harness(responses: Response[]): {
  provider: VastProvider;
  requests: Request[];
} {
  const requests: Request[] = [];
  const provider = new VastProvider({
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

describe("Vast.ai account metadata", () => {
  test("returns documented identity and signed balance without extra provider data", async () => {
    const { provider, requests } = harness([
      json({
        email: "operator@example.invalid",
        balance: -0.125,
        id: 10,
        api_key,
        ssh_key: "private-key",
      }),
    ]);
    const result = await provider.getAccountMetadata();
    expect(result).toEqual({
      provider_id: "vast",
      email: "operator@example.invalid",
      balance: -0.125,
      currency: "USD",
    });
    expect(requests[0]?.url).toBe(
      "https://cloud.vast.ai/api/v0/users/current/",
    );
    expect(requests[0]?.headers.get("authorization")).toBe(`Bearer ${api_key}`);
    expect(requests[0]?.redirect).toBe("error");
    expect(await requests[0]?.text()).toBe("");
  });

  test("does not manufacture unavailable financial fields", async () => {
    const { provider } = harness([json({ email: "operator@example.invalid" })]);
    expect(await provider.getAccountMetadata()).toEqual({
      provider_id: "vast",
      email: "operator@example.invalid",
      currency: "USD",
    });
  });

  test.each([
    {},
    { email: "" },
    { email: "operator@example.invalid", balance: "2.5" },
    { email: "operator@example.invalid", balance: null },
  ])(
    "rejects malformed metadata without exposing it (%j)",
    async (response) => {
      const { provider } = harness([
        json({ ...response, api_key: "private-key" }),
      ]);
      const error = await provider
        .getAccountMetadata()
        .catch((error: unknown) => error);
      expect(error).toMatchObject({ code: "invalid_response" });
      expect(String(error)).not.toContain("private-key");
    },
  );
});

describe("Vast.ai inventory", () => {
  test("follows v1 pagination and safely normalizes instance fields", async () => {
    const { provider, requests } = harness([
      json({
        success: true,
        instances: [instance()],
        next_token: "cursor+/=one",
      }),
      json({
        success: true,
        instances: [
          instance({
            id: 457,
            label: null,
            public_ipaddr: null,
            dph_total: null,
          }),
        ],
        next_token: null,
      }),
    ]);
    const result = await provider.listInstances();
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      provider_id: "vast",
      id: "456",
      label: "worker",
      region_id: "",
      plan_id: "",
      image_id: "example/workload:latest",
      status: "running",
      provider_status: "running",
      power_status: "running",
      server_status: "running",
      public_ipv4: "192.0.2.10",
      public_ipv6: "",
      tags: [],
      gpu_name: "Example GPU",
      gpu_count: 2,
      gpu_memory_gb: 24,
      hourly_cost: 0.25,
      ssh_host: "ssh.example.invalid",
      ssh_port: 22000,
    });
    expect(result[1]?.label).toBe("");
    expect(result[1]).not.toHaveProperty("hourly_cost");
    expect(JSON.stringify(result)).not.toMatch(
      /private|extra_env|jupyter_token/,
    );
    const first_url = new URL(requests[0]?.url ?? "");
    expect(first_url.origin).toBe("https://cloud.vast.ai");
    expect(first_url.pathname).toBe("/api/v1/instances/");
    expect(first_url.searchParams.get("limit")).toBe("25");
    expect(JSON.parse(first_url.searchParams.get("order_by") ?? "")).toEqual([
      { col: "id", dir: "asc" },
    ]);
    expect(
      new URL(requests[1]?.url ?? "").searchParams.get("after_token"),
    ).toBe("cursor+/=one");
  });

  test.each([
    ["running", "running"],
    ["stopped", "stopped"],
    ["exited", "stopped"],
    ["creating", "pending"],
    ["loading", "pending"],
    ["scheduling", "pending"],
    ["connecting", "pending"],
    ["rebooting", "pending"],
    ["offline", "unknown"],
    [null, "unknown"],
  ] as const)(
    "maps actual state %s without relying on desired state",
    async (actual_status, expected) => {
      const { provider } = harness([
        json({ instances: [instance({ actual_status })], next_token: null }),
      ]);
      expect((await provider.listInstances())[0]?.status).toBe(expected);
    },
  );

  test("allows absent optional fields and recognizes IPv6", async () => {
    const { provider } = harness([
      json({
        instances: [{ id: 456, public_ipaddr: "2001:db8::10" }],
        next_token: null,
      }),
    ]);
    expect((await provider.listInstances())[0]).toMatchObject({
      label: "",
      status: "unknown",
      public_ipv4: "",
      public_ipv6: "2001:db8::10",
    });
  });

  test("rejects repeated pagination tokens", async () => {
    const { provider, requests } = harness([
      json({ instances: [], next_token: "same" }),
      json({ instances: [], next_token: "same" }),
    ]);
    await expect(provider.listInstances()).rejects.toMatchObject({
      code: "invalid_response",
    });
    expect(requests).toHaveLength(2);
  });

  test("rejects duplicate IDs across pages", async () => {
    const { provider } = harness([
      json({ instances: [instance()], next_token: "next" }),
      json({ instances: [instance()], next_token: null }),
    ]);
    await expect(provider.listInstances()).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  test.each([
    { instances: [] },
    { instances: {}, next_token: null },
    { instances: [{ id: "456" }], next_token: null },
    { instances: [instance({ dph_total: -1 })], next_token: null },
  ])(
    "rejects incomplete or malformed paginated data (%j)",
    async (response) => {
      const { provider } = harness([json(response)]);
      await expect(provider.listInstances()).rejects.toMatchObject({
        code: "invalid_response",
      });
    },
  );

  test("fetches a single owned instance using v0", async () => {
    const { provider, requests } = harness([json({ instances: instance() })]);
    expect((await provider.getInstance("456")).id).toBe("456");
    expect(requests[0]?.url).toBe(
      "https://cloud.vast.ai/api/v0/instances/456/?owner=me",
    );
  });

  test("reports a missing instance", async () => {
    const { provider } = harness([json({ instances: null })]);
    await expect(provider.getInstance("456")).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("Vast.ai on-demand rental", () => {
  test("searches verified rentable offers with allocation-aware costs", async () => {
    const { provider, requests } = harness([
      json({ offers: [offer({ internal: "private" })] }),
    ]);
    expect(
      await provider.listOffers({
        gpu_name: "Example GPU",
        gpu_count: 2,
        disk_gb: 20,
        limit: 5,
      }),
    ).toEqual([
      {
        id: "123",
        gpu_name: "Example GPU",
        gpu_count: 2,
        hourly_cost: 0.25,
        currency: "USD",
        vcpu_count: 8.5,
        memory_mb: 32000,
        disk_gb: 100,
        gpu_memory_gb: 24,
        reliability: 0.99,
      },
    ]);
    expect(requests[0]?.url).toBe("https://cloud.vast.ai/api/v0/bundles/");
    expect(requests[0]?.method).toBe("POST");
    expect(await requests[0]?.json()).toEqual({
      type: "ondemand",
      verified: { eq: true },
      rentable: { eq: true },
      rented: { eq: false },
      external: { eq: false },
      order: [["dph_total", "asc"]],
      limit: 5,
      gpu_name: { eq: "Example GPU" },
      num_gpus: { eq: 2 },
      allocated_storage: 20,
      disk_space: { gte: 20 },
    });
  });

  test("bounds default discovery and omits unknown offer attributes", async () => {
    const { provider, requests } = harness([
      json({
        offers: [
          { id: 123, gpu_name: "Example GPU", num_gpus: 1, dph_total: 0 },
        ],
      }),
    ]);
    expect(await provider.listOffers()).toEqual([
      {
        id: "123",
        gpu_name: "Example GPU",
        gpu_count: 1,
        hourly_cost: 0,
        currency: "USD",
      },
    ]);
    expect(JSON.parse((await requests[0]?.text()) ?? "").limit).toBe(20);
  });

  test.each([
    { limit: 0 },
    { limit: 101 },
    { gpu_count: 1.5 },
    { disk_gb: 0 },
    { gpu_name: "" },
  ])("rejects invalid discovery input before HTTP (%j)", async (query) => {
    const { provider, requests } = harness([]);
    await expect(
      provider.listOffers(query as OfferQuery),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(requests).toHaveLength(0);
  });

  test("an offer search network failure is correctly treated as read-only", async () => {
    const { provider, requests } = harness([]);
    const error = await provider.listOffers().catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "network_error" });
    expect(String(error)).not.toContain("may have succeeded");
    expect(requests).toHaveLength(1);
  });

  test("rents only the explicit offer with SSH and returns acceptance without a second request", async () => {
    const { provider, requests } = harness([
      json({ success: true, new_contract: 456 }),
    ]);
    const result = await provider.createInstance({
      ...create_input,
      label: "worker",
      enable_ssh: true,
    });
    expect(result).toMatchObject({
      id: "456",
      label: "worker",
      status: "accepted",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://cloud.vast.ai/api/v0/asks/123/");
    expect(requests[0]?.method).toBe("PUT");
    expect(await requests[0]?.json()).toEqual({
      client_id: "me",
      image: "example/workload:latest",
      disk: 20,
      runtype: "ssh",
      cancel_unavail: true,
      label: "worker",
    });
    expect(result).not.toHaveProperty("hourly_cost");
  });

  test("does not add a label or bid price unless configured", async () => {
    const { provider, requests } = harness([
      json({ success: true, new_contract: 456 }),
    ]);
    await provider.createInstance(create_input);
    const body = await requests[0]?.json();
    expect(body).not.toHaveProperty("label");
    expect(body).not.toHaveProperty("price");
  });

  test.each([
    ["region_id", "example-region"],
    ["plan_id", "example-plan"],
    ["hostname", "example-host"],
    ["ssh_key_ids", []],
    ["tags", []],
    ["enable_ipv6", false],
    ["enable_ssh", false],
    ["gpu_count", 1],
    ["volume_gb", 10],
    ["ports", []],
  ])(
    "rejects unsupported create field %s before HTTP",
    async (field, value) => {
      const { provider, requests } = harness([]);
      const input = { ...create_input, [field as string]: value };
      expect(() => validateCreateInput(input)).toThrow();
      await expect(provider.createInstance(input)).rejects.toMatchObject({
        code: "unsupported_operation",
      });
      expect(requests).toHaveLength(0);
    },
  );

  test.each([
    {},
    { image_id: "example/image:latest", disk_gb: 10 },
    { offer_id: "123", disk_gb: 10 },
    { ...create_input, offer_id: "../../other" },
    { ...create_input, offer_id: "0" },
    { ...create_input, disk_gb: 0 },
    { ...create_input, disk_gb: Number.NaN },
    { ...create_input, image_id: " image " },
    { ...create_input, label: "line\nbreak" },
    { ...create_input, price: 100 },
  ])("rejects invalid create input before HTTP (%j)", async (input) => {
    const { provider, requests } = harness([]);
    await expect(
      provider.createInstance(input as CreateInstanceInput),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(requests).toHaveLength(0);
  });

  test("makes ambiguous malformed rental responses actionable without retrying", async () => {
    const { provider, requests } = harness([
      json({ success: true, unrelated: "private" }),
    ]);
    const error = await provider
      .createInstance(create_input)
      .catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "invalid_response" });
    expect(String(error)).toContain("may have succeeded");
    expect(String(error)).not.toContain("private");
    expect(requests).toHaveLength(1);
  });
});

describe("Vast.ai lifecycle", () => {
  test.each([
    ["startInstance", "PUT", "/v0/instances/456/", { state: "running" }],
    ["stopInstance", "PUT", "/v0/instances/456/", { state: "stopped" }],
    ["rebootInstance", "PUT", "/v0/instances/reboot/456/", {}],
    ["destroyInstance", "DELETE", "/v0/instances/456/", undefined],
  ] as const)(
    "%s uses documented endpoint and acknowledgment",
    async (operation, method, path, body) => {
      const { provider, requests } = harness([json({ success: true })]);
      await provider[operation]("456");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.method).toBe(method);
      expect(requests[0]?.url).toBe(`https://cloud.vast.ai/api${path}`);
      expect(await requests[0]?.text()).toBe(
        body === undefined ? "" : JSON.stringify(body),
      );
    },
  );

  test("edits a label without follow-up requests after acknowledgement", async () => {
    const { provider, requests } = harness([json({ success: true })]);
    expect(
      await provider.editInstance("456", { label: "updated" }),
    ).toMatchObject({
      id: "456",
      label: "updated",
      status: "accepted",
    });
    expect(requests).toHaveLength(1);
    expect(await requests[0]?.json()).toEqual({ label: "updated" });
  });

  test.each(["tags", "plan_id"])(
    "rejects unsupported edits before HTTP (%s)",
    async (field) => {
      const input: EditInstanceInput =
        field === "tags" ? { tags: [] } : { plan_id: "another" };
      const { provider, requests } = harness([]);
      expect(() => validateEditInput(input)).toThrow();
      await expect(provider.editInstance("456", input)).rejects.toMatchObject({
        code: "unsupported_operation",
      });
      expect(requests).toHaveLength(0);
    },
  );

  test.each([{}, { label: 4 }, { label: "a".repeat(1025) }])(
    "rejects invalid edit input before HTTP (%j)",
    async (input) => {
      const { provider, requests } = harness([]);
      await expect(
        provider.editInstance("456", input as EditInstanceInput),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(requests).toHaveLength(0);
    },
  );

  test.each(["", "0", "-1", "1.5", "1/../2", "1?token=x", "9007199254740992"])(
    "rejects invalid instance ID %s before HTTP",
    async (id) => {
      const { provider, requests } = harness([]);
      await expect(provider.getInstance(id)).rejects.toMatchObject({
        code: "invalid_input",
      });
      await expect(provider.startInstance(id)).rejects.toMatchObject({
        code: "invalid_input",
      });
      await expect(provider.stopInstance(id)).rejects.toMatchObject({
        code: "invalid_input",
      });
      await expect(provider.rebootInstance(id)).rejects.toMatchObject({
        code: "invalid_input",
      });
      await expect(provider.destroyInstance(id)).rejects.toMatchObject({
        code: "invalid_input",
      });
      await expect(
        provider.editInstance(id, { label: "worker" }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(requests).toHaveLength(0);
    },
  );

  test.each(["listRegions", "listPlans", "listImages", "listSshKeys"] as const)(
    "%s accurately reports unsupported catalog",
    async (operation) => {
      const { provider, requests } = harness([]);
      await expect(provider[operation]()).rejects.toMatchObject({
        code: "unsupported_operation",
      });
      expect(requests).toHaveLength(0);
    },
  );

  test("treats HTTP 200 success:false as a failed operation without echoing private messages", async () => {
    const { provider, requests } = harness([
      json({ success: false, error: "auth_error", msg: `private ${api_key}` }),
    ]);
    const error = await provider
      .startInstance("456")
      .catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "authentication" });
    expect(String(error)).not.toMatch(/private|synthetic/);
    expect(requests).toHaveLength(1);
  });

  test.each([{}, { success: "true" }, { success: false }])(
    "requires an explicit successful mutation acknowledgement (%j)",
    async (response) => {
      const { provider } = harness([json(response)]);
      await expect(provider.destroyInstance("456")).rejects.toBeDefined();
    },
  );
});

describe("Vast.ai cancellation", () => {
  test("does not send metadata or listing requests after cancellation", async () => {
    const { provider, requests } = harness([]);
    const controller = new AbortController();
    controller.abort("private cancellation reason");
    await expect(
      provider.getAccountMetadata({ signal: controller.signal }),
    ).rejects.toMatchObject({ code: "cancelled" });
    await expect(
      provider.listInstances({ signal: controller.signal }),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(requests).toHaveLength(0);
  });

  test("stops pagination when aborted between pages", async () => {
    const controller = new AbortController();
    const requests: Request[] = [];
    const provider = new VastProvider({
      api_key,
      fetch: async (request) => {
        requests.push(request);
        const response = json({ instances: [], next_token: "next" });
        const original_json = response.json.bind(response);
        Object.defineProperty(response, "json", {
          value: async () => {
            const result: unknown = await original_json();
            controller.abort();
            return result;
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

  test("forwards active cancellation to native HTTP requests", async () => {
    const controller = new AbortController();
    let native_signal: AbortSignal | undefined;
    const provider = new VastProvider({
      api_key,
      fetch: async (request) => {
        native_signal = request.signal;
        controller.abort();
        return new Promise<Response>(() => {});
      },
    });
    await expect(
      provider.getAccountMetadata({ signal: controller.signal }),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(native_signal?.aborted).toBe(true);
  });
});
