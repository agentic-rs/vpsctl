import { describe, expect, test } from "bun:test";
import type {
  CreateInstanceInput,
  EditInstanceInput,
  InstanceStatus,
} from "../src/core/provider.ts";
import {
  RunpodProvider,
  validateCreateInput,
  validateEditInput,
} from "../src/providers/runpod/index.ts";

const api_key = "synthetic-runpod-api-key";
const create_input: CreateInstanceInput = {
  plan_id: "NVIDIA Example GPU",
  image_id: "example/workload:latest",
  label: "example-pod",
  disk_gb: 40,
};

function pod(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "pod-1",
    name: "example-pod",
    image: "example/workload:latest",
    status: "RUNNING",
    dataCenterId: "DC-1",
    gpu: { id: "NVIDIA Example GPU", count: 2, memory: 64, vcpuCount: 16 },
    cost: 0.85,
    ssh: {
      direct: { host: "192.0.2.10", port: 22022, username: "synthetic-user" },
      proxy: { host: "ssh.runpod.io", port: 22 },
    },
    env: { PRIVATE_VALUE: "private-environment-value" },
    registry: "private-registry-id",
    apiKey: "private-provider-key",
    ...overrides,
  };
}

function account(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    email: "user@example.invalid",
    clientBalance: 12.34,
    currentSpendPerHr: 0.85,
    information: { firstName: "Example", lastName: "User" },
    ...overrides,
  };
}

function page(
  pods: Record<string, unknown>[] = [],
  next_cursor: string | null = null,
): Response {
  return Response.json({
    pods,
    pagination: { nextCursor: next_cursor, hasNextPage: next_cursor !== null },
  });
}

function harness(responses: Response[]): {
  provider: RunpodProvider;
  requests: Request[];
} {
  const requests: Request[] = [];
  const provider = new RunpodProvider({
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

describe("RunPod account metadata", () => {
  test("reads verified identity and credits with a narrow read-only GraphQL query", async () => {
    const { provider, requests } = harness([
      Response.json({ data: { myself: account({ apiKey: "private-key" }) } }),
    ]);
    const result = await provider.getAccountMetadata();
    expect(result).toEqual({
      provider_id: "runpod",
      name: "Example User",
      email: "user@example.invalid",
      balance: 12.34,
      hourly_cost: 0.85,
      currency: "USD",
    });
    const request = requests[0];
    expect(request?.url).toBe("https://api.runpod.io/graphql");
    expect(request?.method).toBe("POST");
    expect(request?.headers.get("authorization")).toBe(`Bearer ${api_key}`);
    expect(request?.redirect).toBe("error");
    expect(await request?.json()).toEqual({
      query:
        "query AccountMetadata { myself { email clientBalance currentSpendPerHr information { firstName lastName } } }",
    });
    expect(JSON.stringify(result)).not.toContain("private-key");
    expect(JSON.stringify(provider)).not.toContain(api_key);
  });

  test("omits unavailable optional billing and name fields", async () => {
    const { provider } = harness([
      Response.json({
        data: {
          myself: account({
            clientBalance: null,
            currentSpendPerHr: null,
            information: null,
          }),
        },
      }),
    ]);
    expect(await provider.getAccountMetadata()).toEqual({
      provider_id: "runpod",
      email: "user@example.invalid",
      currency: "USD",
    });
  });

  test("preserves signed balance and genuine zero spend", async () => {
    const { provider } = harness([
      Response.json({
        data: {
          myself: account({ clientBalance: -0.125, currentSpendPerHr: 0 }),
        },
      }),
    ]);
    const result = await provider.getAccountMetadata();
    expect(result.balance).toBe(-0.125);
    expect(result.hourly_cost).toBe(0);
    expect(result.pending_charges).toBeUndefined();
    expect(result.last_payment_amount).toBeUndefined();
  });

  test.each([
    ["UNAUTHENTICATED", "authentication"],
    ["FORBIDDEN", "forbidden"],
    ["OTHER_CODE", "provider_error"],
  ])(
    "classifies GraphQL %s without echoing error data",
    async (code, expected) => {
      const { provider } = harness([
        Response.json({
          errors: [
            { message: `Private error ${api_key}`, extensions: { code } },
          ],
          data: { myself: account() },
        }),
      ]);
      const error = await provider
        .getAccountMetadata()
        .catch((error: unknown) => error);
      expect(error).toMatchObject({ code: expected });
      expect(String(error)).not.toContain(api_key);
      expect(String(error)).not.toContain("Private error");
    },
  );

  test.each([
    {},
    { data: { myself: null } },
    { data: { myself: account({ email: null }) } },
    { data: { myself: account({ clientBalance: "12.34" }) } },
  ])(
    "rejects malformed metadata without exposing the body",
    async (response) => {
      const { provider } = harness([Response.json(response)]);
      await expect(provider.getAccountMetadata()).rejects.toMatchObject({
        code: "invalid_response",
      });
    },
  );

  test("a metadata POST network error is read-only and has no mutation retry advice", async () => {
    const provider = new RunpodProvider({
      api_key,
      fetch: async () => {
        throw new Error(`private ${api_key}`);
      },
    });
    const error = await provider
      .getAccountMetadata()
      .catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "network_error" });
    expect(String(error)).not.toContain("may have succeeded");
    expect(String(error)).not.toContain(api_key);
  });
});

describe("RunPod inventory", () => {
  test("normalizes only public facts and never treats system RAM as GPU VRAM", async () => {
    const { provider, requests } = harness([Response.json(pod())]);
    const result = await provider.getInstance("pod-1");
    expect(result).toEqual({
      provider_id: "runpod",
      id: "pod-1",
      label: "example-pod",
      image_id: "example/workload:latest",
      region_id: "DC-1",
      plan_id: "NVIDIA Example GPU",
      status: "running",
      provider_status: "RUNNING",
      power_status: "running",
      server_status: "",
      public_ipv4: "192.0.2.10",
      public_ipv6: "",
      tags: [],
      gpu_name: "NVIDIA Example GPU",
      gpu_count: 2,
      hourly_cost: 0.85,
      ssh_host: "192.0.2.10",
      ssh_port: 22022,
    });
    expect(result.gpu_memory_gb).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/private|synthetic-user/);
    expect(requests[0]?.url).toBe("https://api.runpod.io/v2/pods/pod-1");
  });

  test.each([
    ["PROVISIONING", "pending"],
    ["STARTING", "pending"],
    ["RUNNING", "running"],
    ["EXITED", "stopped"],
    ["ERROR", "unknown"],
    ["TERMINATED", "unknown"],
    ["FUTURE", "unknown"],
  ])("maps provider lifecycle %s to %s", async (status, expected) => {
    const { provider } = harness([
      Response.json(pod({ status, ssh: null, dataCenterId: null })),
    ]);
    const result = await provider.getInstance("pod-1");
    expect(result.status).toBe(expected as InstanceStatus);
    expect(result.region_id).toBe("");
    expect(result.ssh_host).toBeUndefined();
  });

  test("uses proxy SSH without inventing a public IP", async () => {
    const { provider } = harness([
      Response.json(
        pod({
          ssh: { direct: null, proxy: { host: "ssh.runpod.io", port: 22 } },
        }),
      ),
    ]);
    const result = await provider.getInstance("pod-1");
    expect(result.ssh_host).toBe("ssh.runpod.io");
    expect(result.public_ipv4).toBe("");
  });

  test("preserves existing CPU Pod identity without inventing GPU data", async () => {
    const { provider } = harness([
      Response.json(pod({ gpu: undefined, cpu: { id: "cpu-example" } })),
    ]);
    const result = await provider.getInstance("pod-1");
    expect(result.plan_id).toBe("cpu-example");
    expect(result.gpu_count).toBeUndefined();
  });

  test("follows opaque cursor pages and returns standalone Pods", async () => {
    const { provider, requests } = harness([
      page([pod()], "next /+?="),
      page([pod({ id: "pod-2" })]),
    ]);
    expect(
      (await provider.listInstances()).map((instance) => instance.id),
    ).toEqual(["pod-1", "pod-2"]);
    expect(requests).toHaveLength(2);
    const first_url = new URL(requests[0]?.url ?? "");
    const next_url = new URL(requests[1]?.url ?? "");
    expect(first_url.pathname).toBe("/v2/pods");
    expect(first_url.searchParams.get("limit")).toBe("1000");
    expect(first_url.searchParams.has("includeClusterPods")).toBe(false);
    expect(next_url.searchParams.get("cursor")).toBe("next /+?=");
  });

  test("rejects repeated cursors and avoids a third request", async () => {
    const { provider, requests } = harness([
      page([], "again"),
      page([], "again"),
    ]);
    await expect(provider.listInstances()).rejects.toMatchObject({
      code: "invalid_response",
    });
    expect(requests).toHaveLength(2);
  });

  test("rejects pagination that claims another page without a cursor", async () => {
    const { provider } = harness([
      Response.json({
        pods: [],
        pagination: { nextCursor: null, hasNextPage: true },
      }),
    ]);
    await expect(provider.listInstances()).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  test.each([
    "../escape",
    "pod/1",
    "https://example.invalid",
    "pod?key=secret",
    "",
  ])("rejects unsafe Pod ID %s before any request", async (id) => {
    const { provider, requests } = harness([]);
    await expect(provider.getInstance(id)).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(provider.destroyInstance(id)).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(requests).toHaveLength(0);
  });

  test.each(["metadata", "inventory"] as const)(
    "forwards cancellation to %s reads",
    async (operation) => {
      const controller = new AbortController();
      let request_signal: AbortSignal | undefined;
      const provider = new RunpodProvider({
        api_key,
        fetch: async (request) => {
          request_signal = request.signal;
          controller.abort("private abort reason");
          return new Promise<Response>(() => {});
        },
      });
      const result =
        operation === "metadata"
          ? provider.getAccountMetadata({ signal: controller.signal })
          : provider.listInstances({ signal: controller.signal });
      const error = await result.catch((error: unknown) => error);
      expect(error).toMatchObject({ code: "cancelled" });
      expect(request_signal?.aborted).toBe(true);
      expect(String(error)).not.toContain("private abort reason");
    },
  );
});

describe("RunPod mutations", () => {
  test("creates only secure on-demand GPU Pods with explicit name, image and disk", async () => {
    const { provider, requests } = harness([
      Response.json(pod({ status: "PROVISIONING" }), { status: 201 }),
    ]);
    const result = await provider.createInstance(create_input);
    expect(result.status).toBe("pending");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.url).toBe("https://api.runpod.io/v2/pods");
    expect(await requests[0]?.json()).toEqual({
      name: "example-pod",
      image: "example/workload:latest",
      cloud: "SECURE",
      gpu: { id: "NVIDIA Example GPU", count: 1 },
      disk: 40,
    });
  });

  test("maps placement, storage, count, ports and SSH without hidden key selection", async () => {
    const { provider, requests } = harness([Response.json(pod())]);
    await provider.createInstance({
      ...create_input,
      region_id: "DC-1",
      gpu_count: 2,
      volume_gb: 10,
      ports: ["8888/http", "8888/http"],
      enable_ssh: true,
    });
    expect(await requests[0]?.json()).toEqual({
      name: "example-pod",
      image: "example/workload:latest",
      cloud: "SECURE",
      gpu: { id: "NVIDIA Example GPU", count: 2 },
      disk: 40,
      dataCenterIds: ["DC-1"],
      ports: ["8888/http", "22/tcp"],
      startSsh: true,
      mounts: { persistent: { size: 10, path: "/workspace" } },
    });
  });

  test("an explicitly zero volume adds no persistent mount", async () => {
    const { provider, requests } = harness([Response.json(pod())]);
    await provider.createInstance({
      ...create_input,
      volume_gb: 0,
      enable_ssh: false,
    });
    const body = await requests[0]?.json();
    expect(body).not.toHaveProperty("mounts");
    expect(body).toHaveProperty("startSsh", false);
    expect(body).not.toHaveProperty("ports");
  });

  test.each(["plan_id", "image_id", "label", "disk_gb"])(
    "requires %s before any request",
    async (field) => {
      const input = { ...create_input } as Record<string, unknown>;
      delete input[field];
      const { provider, requests } = harness([]);
      expect(() => validateCreateInput(input as CreateInstanceInput)).toThrow();
      await expect(
        provider.createInstance(input as CreateInstanceInput),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(requests).toHaveLength(0);
    },
  );

  test.each([
    { disk_gb: 0 },
    { disk_gb: 1.2 },
    { volume_gb: 9 },
    { gpu_count: 0 },
    { gpu_count: 1.5 },
    { label: " " },
    { ports: ["65536/tcp"] },
    { ports: ["22/udp"] },
    { ports: ["0/tcp"] },
    { region_id: "../other" },
    { image_id: "image with spaces" },
  ])("rejects invalid create parameters before any request", async (fields) => {
    const { provider, requests } = harness([]);
    await expect(
      provider.createInstance({
        ...create_input,
        ...fields,
      } as CreateInstanceInput),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(requests).toHaveLength(0);
  });

  test.each([
    { hostname: "example-host" },
    { ssh_key_ids: [] },
    { tags: [] },
    { enable_ipv6: false },
    { offer_id: "1" },
    { spot: true },
  ])(
    "rejects unsupported create options instead of ignoring them",
    async (fields) => {
      const { provider, requests } = harness([]);
      await expect(
        provider.createInstance({
          ...create_input,
          ...fields,
        } as CreateInstanceInput),
      ).rejects.toMatchObject({ code: "unsupported_operation" });
      expect(requests).toHaveLength(0);
    },
  );

  test("returns accepted create identity without an extra GET when only ID is returned", async () => {
    const { provider, requests } = harness([
      Response.json(
        { id: "pod-2", env: { secret: "private" } },
        { status: 201 },
      ),
    ]);
    expect(await provider.createInstance(create_input)).toEqual({
      provider_id: "runpod",
      id: "pod-2",
      status: "accepted",
      label: "example-pod",
    });
    expect(requests).toHaveLength(1);
  });

  test("reports ambiguous create results without retries or a follow-up request", async () => {
    const { provider, requests } = harness([
      Response.json({ secret: "private-response" }, { status: 201 }),
    ]);
    const error = await provider
      .createInstance(create_input)
      .catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "invalid_response" });
    expect(String(error)).toContain("may have succeeded");
    expect(String(error)).not.toContain("private-response");
    expect(requests).toHaveLength(1);
  });

  test("edits the Pod name through PATCH", async () => {
    const { provider, requests } = harness([
      Response.json(pod({ name: "renamed-pod" })),
    ]);
    const result = await provider.editInstance("pod-1", {
      label: "renamed-pod",
    });
    expect(result.label).toBe("renamed-pod");
    expect(requests[0]?.method).toBe("PATCH");
    expect(await requests[0]?.json()).toEqual({ name: "renamed-pod" });
  });

  test("returns an accepted edit result when complete Pod metadata is absent", async () => {
    const { provider, requests } = harness([Response.json({ id: "pod-1" })]);
    expect(
      await provider.editInstance("pod-1", { label: "renamed-pod" }),
    ).toEqual({
      provider_id: "runpod",
      id: "pod-1",
      status: "accepted",
      label: "renamed-pod",
    });
    expect(requests).toHaveLength(1);
  });

  test.each([
    { tags: [] },
    { plan_id: "other-gpu" },
    { label: "new", plan_id: "other-gpu" },
  ])("rejects unsupported edits before any fetch", async (input) => {
    const edit_input = input as EditInstanceInput;
    const { provider, requests } = harness([]);
    expect(() => validateEditInput(edit_input)).toThrow();
    await expect(
      provider.editInstance("pod-1", edit_input),
    ).rejects.toMatchObject({ code: "unsupported_operation" });
    expect(requests).toHaveLength(0);
  });

  test.each([{}, { label: "" }])("rejects empty edits", async (input) => {
    const { provider } = harness([]);
    await expect(provider.editInstance("pod-1", input)).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  test("rejects a different Pod ID in a mutation response", async () => {
    const { provider } = harness([Response.json(pod({ id: "other-pod" }))]);
    await expect(
      provider.editInstance("pod-1", { label: "new" }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  test.each([
    ["startInstance", "start"],
    ["stopInstance", "stop"],
    ["rebootInstance", "restart"],
  ] as const)(
    "sends %s through the documented state action endpoint",
    async (method, action) => {
      const { provider, requests } = harness([Response.json(pod())]);
      await provider[method]("pod-1");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe(
        "https://api.runpod.io/v2/pods/pod-1/action",
      );
      expect(requests[0]?.method).toBe("POST");
      expect(await requests[0]?.json()).toEqual({ action });
    },
  );

  test("terminates the Pod with DELETE and accepts the empty 204 result", async () => {
    const { provider, requests } = harness([
      new Response(null, { status: 204 }),
    ]);
    await provider.destroyInstance("pod-1");
    expect(requests[0]?.method).toBe("DELETE");
    expect(await requests[0]?.text()).toBe("");
  });
});

describe("RunPod catalogs", () => {
  test("lists documented data center names without inventing country values", async () => {
    const { provider, requests } = harness([
      Response.json({
        dataCenters: [{ id: "DC-1", name: "Example DC", region: "UNKNOWN" }],
      }),
    ]);
    expect(await provider.listRegions()).toEqual([
      { id: "DC-1", name: "Example DC", country: "" },
    ]);
    expect(requests[0]?.url).toBe(
      "https://api.runpod.io/v2/catalog/datacenters",
    );
  });

  test("lists secure GPU plans with native hourly pricing and actual VRAM", async () => {
    const { provider, requests } = harness([
      Response.json({
        gpus: [
          {
            id: "example-gpu",
            name: "Example GPU",
            memory: 24,
            secure: true,
            price: { secure: 0.44 },
            dataCenters: [
              { id: "DC-1", availability: "HIGH" },
              { id: "DC-2", availability: "NONE" },
            ],
          },
          {
            id: "community-gpu",
            name: "Community GPU",
            memory: 16,
            secure: false,
            price: { secure: 0.2 },
          },
        ],
      }),
    ]);
    expect(await provider.listPlans("DC-1")).toEqual([
      {
        id: "example-gpu",
        name: "Example GPU",
        gpu_name: "Example GPU",
        gpu_count: 1,
        gpu_memory_gb: 24,
        hourly_cost: 0.44,
        currency: "USD",
        region_ids: ["DC-1"],
      },
    ]);
    const url = new URL(requests[0]?.url ?? "");
    expect(url.pathname).toBe("/v2/catalog/gpus");
    expect(url.searchParams.get("cloud")).toBe("SECURE");
    expect(url.searchParams.get("product")).toBe("POD");
    expect(url.searchParams.get("include")).toBe("AVAILABILITY");
  });

  test("supports absent region expansions and returns no match for an unavailable region", async () => {
    const { provider } = harness([
      Response.json({
        gpus: [
          {
            id: "gpu",
            name: "GPU",
            memory: 16,
            secure: true,
            price: { secure: 0.3 },
          },
        ],
      }),
    ]);
    expect(await provider.listPlans("DC-1")).toEqual([]);
  });

  test("images and selectable SSH key IDs fail with guidance without any requests", async () => {
    const { provider, requests } = harness([]);
    await expect(provider.listImages()).rejects.toMatchObject({
      code: "unsupported_operation",
    });
    await expect(provider.listSshKeys()).rejects.toMatchObject({
      code: "unsupported_operation",
    });
    expect(provider.info.capabilities).not.toContain("images");
    expect(provider.info.capabilities).not.toContain("ssh_keys");
    expect(requests).toHaveLength(0);
  });
});
