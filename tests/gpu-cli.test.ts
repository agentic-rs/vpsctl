import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CliIO, runCli } from "../src/commands/program.ts";
import { AccountStore } from "../src/core/accounts.ts";
import { ProviderRegistry } from "../src/core/registry.ts";
import { RunpodProvider } from "../src/providers/runpod/index.ts";
import { VastProvider } from "../src/providers/vast/index.ts";
import { VultrProvider } from "../src/providers/vultr/index.ts";

type ProviderId = "vultr" | "runpod" | "vast";
const api_key = "synthetic-gpu-cli-api-key";
const temp_dirs: string[] = [];
const runpod_create = [
  "--plan",
  "Example GPU",
  "--image",
  "example/workload:latest",
  "--label",
  "example-pod",
  "--disk-gb",
  "40",
];
const vast_create = [
  "--offer",
  "101",
  "--image",
  "example/workload:latest",
  "--disk-gb",
  "20",
];
const vultr_create = [
  "--region",
  "example-region",
  "--plan",
  "example-plan",
  "--image",
  "123",
];

interface RunOptions {
  env?: Readonly<Record<string, string | undefined>>;
  is_interactive?: boolean;
  confirmation?: boolean;
}

async function fixture(
  responses: Partial<Record<ProviderId, Response[]>> = {},
) {
  const temp_dir = await mkdtemp(join(tmpdir(), "vps-ctl-gpu-cli-"));
  temp_dirs.push(temp_dir);
  const config_path = join(temp_dir, "config.json");
  const store = new AccountStore(config_path);
  const requests: { provider_id: string; request: Request }[] = [];
  const connections: string[] = [];
  const registry = new ProviderRegistry(
    new ProviderRegistry().list().map((definition) => ({
      ...definition,
      create(credentials) {
        const provider_id = definition.info.id as ProviderId;
        connections.push(provider_id);
        const options = {
          api_key: credentials.api_key ?? "",
          fetch: async (request: Request) => {
            requests.push({ provider_id, request });
            const response = responses[provider_id]?.shift();
            if (!response) throw new Error("Unexpected test request.");
            return response;
          },
        };
        switch (provider_id) {
          case "vultr":
            return new VultrProvider(options);
          case "runpod":
            return new RunpodProvider(options);
          case "vast":
            return new VastProvider(options);
        }
      },
    })),
  );
  for (const definition of registry.list()) {
    await store.add({
      id: definition.info.id,
      provider_id: definition.info.id,
      credentials: { api_key: { source: "env", name: "SYNTHETIC_API_KEY" } },
    });
  }
  const run = async (argv: string[], options: RunOptions = {}) => {
    const output: string[] = [];
    const errors: string[] = [];
    const confirmations: string[] = [];
    const io: CliIO = {
      write_out: (text) => output.push(text),
      write_err: (text) => errors.push(text),
      is_interactive: options.is_interactive ?? false,
      async confirm(message) {
        confirmations.push(message);
        return options.confirmation ?? false;
      },
    };
    const exit_code = await runCli(
      ["--config", config_path, "--json", ...argv],
      {
        registry,
        io,
        env: options.env ?? { SYNTHETIC_API_KEY: api_key },
      },
    );
    return {
      exit_code,
      stdout: output.join(""),
      stderr: errors.join(""),
      confirmations,
    };
  };
  return { requests, connections, run, store };
}

afterEach(async () => {
  await Promise.all(
    temp_dirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("GPU provider CLI discovery and preflight", () => {
  test("discovers all built-in providers and capabilities without account configuration", async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const code = await runCli(["--json", "provider", "list"], {
      env: {},
      io: {
        write_out: (text) => output.push(text),
        write_err: (text) => errors.push(text),
        is_interactive: false,
        confirm: async () => false,
      },
    });
    expect(code).toBe(0);
    expect(errors).toEqual([]);
    const providers = JSON.parse(output.join("")).data;
    expect(providers.map((provider: { id: string }) => provider.id)).toEqual([
      "vultr",
      "runpod",
      "vast",
    ]);
    expect(
      providers.find((provider: { id: string }) => provider.id === "vast")
        .capabilities,
    ).toContain("offers");
    expect(
      providers.every((provider: { credential_fields: string[] }) =>
        provider.credential_fields.includes("api_key"),
      ),
    ).toBe(true);
  });

  test("requires provider-specific provisioning fields before credentials, confirmation, or HTTP", async () => {
    const { run, connections, requests } = await fixture();
    const required_cases: [ProviderId, string[]][] = [
      ["vultr", ["--plan", "example-plan", "--image", "123"]],
      ["vultr", ["--region", "example-region", "--image", "123"]],
      ["vultr", ["--region", "example-region", "--plan", "example-plan"]],
      [
        "runpod",
        [
          "--image",
          "example/workload:latest",
          "--label",
          "example-pod",
          "--disk-gb",
          "40",
        ],
      ],
      [
        "runpod",
        ["--plan", "Example GPU", "--label", "example-pod", "--disk-gb", "40"],
      ],
      [
        "runpod",
        [
          "--plan",
          "Example GPU",
          "--image",
          "example/workload:latest",
          "--disk-gb",
          "40",
        ],
      ],
      [
        "runpod",
        [
          "--plan",
          "Example GPU",
          "--image",
          "example/workload:latest",
          "--label",
          "example-pod",
        ],
      ],
      ["vast", ["--image", "example/workload:latest", "--disk-gb", "20"]],
      ["vast", ["--offer", "101", "--disk-gb", "20"]],
      ["vast", ["--offer", "101", "--image", "example/workload:latest"]],
    ];
    for (const [provider_id, args] of required_cases) {
      const result = await run(
        ["--account", provider_id, "instance", "create", ...args, "--dry-run"],
        { env: {}, is_interactive: true },
      );
      expect(result.exit_code).toBe(1);
      expect(JSON.parse(result.stderr).error.code).toBe("invalid_input");
      expect(result.stdout).toBe("");
      expect(result.confirmations).toEqual([]);
    }
    expect(connections).toEqual([]);
    expect(requests).toEqual([]);
  });

  test("rejects foreign provider fields even for dry runs", async () => {
    const { run, connections, requests } = await fixture();
    const cases: [ProviderId, string[], string[][]][] = [
      [
        "vultr",
        vultr_create,
        [
          ["--offer", "101"],
          ["--gpu-count", "2"],
          ["--disk-gb", "20"],
          ["--volume-gb", "10"],
          ["--port", "22/tcp"],
          ["--ssh"],
        ],
      ],
      [
        "runpod",
        runpod_create,
        [
          ["--offer", "101"],
          ["--hostname", "example-host"],
          ["--ssh-key", "example-key"],
          ["--tag", "example"],
          ["--enable-ipv6"],
        ],
      ],
      [
        "vast",
        vast_create,
        [
          ["--region", "example-region"],
          ["--plan", "example-plan"],
          ["--gpu-count", "2"],
          ["--volume-gb", "10"],
          ["--port", "22/tcp"],
          ["--hostname", "example-host"],
          ["--ssh-key", "example-key"],
          ["--tag", "example"],
          ["--enable-ipv6"],
        ],
      ],
    ];
    for (const [provider_id, base_args, unsupported_fields] of cases) {
      for (const field_args of unsupported_fields) {
        const result = await run(
          [
            "--account",
            provider_id,
            "instance",
            "create",
            ...base_args,
            ...field_args,
            "--dry-run",
          ],
          { env: {} },
        );
        expect(result.exit_code).toBe(1);
        expect(JSON.parse(result.stderr).error.code).toBe(
          provider_id === "vultr" ? "invalid_input" : "unsupported_operation",
        );
        expect(result.stdout).toBe("");
      }
    }
    expect(connections).toEqual([]);
    expect(requests).toEqual([]);
  });

  test("rejects malformed numeric flags before connecting to a provider", async () => {
    const { run, connections, requests } = await fixture();
    for (const flag of ["--gpu-count", "--disk-gb", "--volume-gb"]) {
      for (const value of [
        "NaN",
        "1.5",
        "-1",
        "Infinity",
        "1e2",
        "9007199254740992",
      ]) {
        const result = await run(
          [
            "--account",
            "runpod",
            "instance",
            "create",
            ...runpod_create,
            flag,
            value,
            "--dry-run",
          ],
          { env: {} },
        );
        expect(result.exit_code).toBe(1);
        expect(JSON.parse(result.stderr).error.code).toBe("invalid_input");
      }
    }
    for (const flag of ["--gpu-count", "--disk-gb", "--limit"]) {
      for (const value of ["0", "NaN", "1.5", "-1"]) {
        const result = await run([
          "--account",
          "vast",
          "spec",
          "list",
          "offer",
          flag,
          value,
        ]);
        expect(result.exit_code).toBe(1);
        expect(JSON.parse(result.stderr).error.code).toBe("invalid_input");
      }
    }
    expect(connections).toEqual([]);
    expect(requests).toEqual([]);
  });

  test("previews provider inputs in snake_case and includes storage consequences without credentials", async () => {
    const { run, connections, requests } = await fixture();
    const result = await run(
      [
        "--account",
        "runpod",
        "instance",
        "create",
        ...runpod_create,
        "--gpu-count",
        "2",
        "--volume-gb",
        "10",
        "--port",
        "8888/http",
        "--port",
        "22/tcp",
        "--ssh",
        "--dry-run",
      ],
      { env: {} },
    );
    expect(result.exit_code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      action: "instance.create",
      data: {
        account_id: "runpod",
        provider_id: "runpod",
        action: "instance.create",
        dry_run: true,
        input: {
          plan_id: "Example GPU",
          image_id: "example/workload:latest",
          label: "example-pod",
          disk_gb: 40,
          gpu_count: 2,
          volume_gb: 10,
          ports: ["8888/http", "22/tcp"],
          enable_ssh: true,
        },
      },
    });
    expect(JSON.parse(result.stdout).data.notice).toContain(
      "Container disk is temporary",
    );
    expect(result.stdout).not.toContain("gpuCount");
    expect(result.stdout).not.toContain(api_key);
    const zero_volume = await run(
      [
        "--account",
        "runpod",
        "instance",
        "create",
        ...runpod_create,
        "--volume-gb",
        "0",
        "--dry-run",
      ],
      { env: {} },
    );
    expect(zero_volume.exit_code).toBe(0);
    expect(JSON.parse(zero_volume.stdout).data.input.volume_gb).toBe(0);
    const vast = await run(
      ["--account", "vast", "instance", "create", ...vast_create, "--dry-run"],
      { env: {} },
    );
    expect(vast.exit_code).toBe(0);
    expect(JSON.parse(vast.stdout).data.input).toEqual({
      offer_id: "101",
      image_id: "example/workload:latest",
      disk_gb: 20,
    });
    expect(JSON.parse(vast.stdout).data.notice).toContain(
      "storage, and bandwidth are billed separately",
    );
    expect(connections).toEqual([]);
    expect(requests).toEqual([]);
  });

  test("stop previews disclose provider-specific storage behavior", async () => {
    const { run, connections, requests } = await fixture();
    const runpod = await run(
      ["--account", "runpod", "instance", "stop", "pod-1", "--dry-run"],
      { env: {} },
    );
    expect(runpod.exit_code).toBe(0);
    expect(JSON.parse(runpod.stdout).data.notice).toContain(
      "Stopping erases the container disk",
    );
    const vast = await run(
      ["--account", "vast", "instance", "stop", "201", "--dry-run"],
      { env: {} },
    );
    expect(vast.exit_code).toBe(0);
    expect(JSON.parse(vast.stdout).data.notice).toContain(
      "continues charging for storage",
    );
    expect(connections).toEqual([]);
    expect(requests).toEqual([]);
  });

  test("rejects unsupported GPU edits before prompting or resolving credentials", async () => {
    const { run, connections, requests } = await fixture();
    for (const provider_id of ["runpod", "vast"]) {
      for (const fields of [
        ["--plan", "example-plan"],
        ["--tag", "example"],
        ["--clear-tags"],
      ]) {
        const result = await run(
          [
            "--account",
            provider_id,
            "instance",
            "edit",
            provider_id === "vast" ? "201" : "pod-1",
            ...fields,
            "--dry-run",
          ],
          { env: {}, is_interactive: true },
        );
        expect(result.exit_code).toBe(1);
        expect(JSON.parse(result.stderr).error.code).toBe(
          "unsupported_operation",
        );
        expect(result.confirmations).toEqual([]);
      }
    }
    expect(connections).toEqual([]);
    expect(requests).toEqual([]);
  });

  test("rejects provider-specific instance IDs before previewing or confirming mutations", async () => {
    const { run, connections, requests } = await fixture();
    for (const [provider_id, invalid_id] of [
      ["runpod", "pod:example"],
      ["vast", "not-a-number"],
    ] as const) {
      for (const action of ["start", "stop", "reboot", "destroy", "edit"]) {
        for (const preview_flags of [["--dry-run"], []]) {
          const result = await run(
            [
              "--account",
              provider_id,
              "instance",
              action,
              invalid_id,
              ...(action === "edit" ? ["--label", "example-label"] : []),
              ...preview_flags,
            ],
            { env: {}, is_interactive: true, confirmation: true },
          );
          expect(result.exit_code).toBe(1);
          expect(JSON.parse(result.stderr).error.code).toBe("invalid_input");
          expect(result.stdout).toBe("");
          expect(result.confirmations).toEqual([]);
        }
      }
    }
    expect(connections).toEqual([]);
    expect(requests).toEqual([]);
  });
});

describe("GPU provider CLI requests", () => {
  test("derives verified GPU account IDs and checks inventory before saving login", async () => {
    const { run, store, requests } = await fixture({
      runpod: [
        Response.json({
          data: {
            myself: { email: "operator@example.invalid", clientBalance: 12.5 },
          },
        }),
        Response.json({
          pods: [],
          pagination: { nextCursor: null, hasNextPage: false },
        }),
      ],
      vast: [
        Response.json({ email: "operator@example.invalid", balance: 12.5 }),
        Response.json({ instances: [], next_token: null }),
      ],
    });
    for (const provider_id of ["runpod", "vast"]) {
      const result = await run([
        "auth",
        "login",
        "--provider",
        provider_id,
        "--credential",
        "api_key=SYNTHETIC_API_KEY",
      ]);
      expect(result.exit_code).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout).data).toEqual({
        id: `${provider_id}:operator@example.invalid`,
        provider_id,
        status: "authenticated",
        instance_count: 0,
      });
      expect(result.stdout).not.toContain(api_key);
      expect(
        (await store.read()).accounts.find(
          (account) => account.id === `${provider_id}:operator@example.invalid`,
        ),
      ).toEqual({
        id: `${provider_id}:operator@example.invalid`,
        provider_id,
        credentials: { api_key: { source: "env", name: "SYNTHETIC_API_KEY" } },
      });
    }
    expect(requests).toHaveLength(4);
    expect(
      requests.map(({ request }) => new URL(request.url).pathname),
    ).toEqual([
      "/graphql",
      "/v2/pods",
      "/api/v0/users/current/",
      "/api/v1/instances/",
    ]);
  });

  test("routes confirmed RunPod creates through the adapter with a single mutation request", async () => {
    const { run, requests, connections } = await fixture({
      runpod: [Response.json({ id: "pod-1" }, { status: 201 })],
    });
    const result = await run(
      [
        "--account",
        "runpod",
        "instance",
        "create",
        ...runpod_create,
        "--region",
        "example-region",
        "--gpu-count",
        "2",
        "--volume-gb",
        "10",
        "--port",
        "8888/http",
        "--ssh",
      ],
      { is_interactive: true, confirmation: true },
    );
    expect(result.exit_code).toBe(0);
    expect(result.confirmations).toEqual(["Apply this change?"]);
    expect(result.stderr).toContain("Container disk is temporary");
    expect(JSON.parse(result.stdout)).toEqual({
      account_id: "runpod",
      provider_id: "runpod",
      action: "instance.create",
      data: {
        provider_id: "runpod",
        id: "pod-1",
        status: "accepted",
        label: "example-pod",
      },
    });
    expect(connections).toEqual(["runpod"]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.request.url).toBe("https://api.runpod.io/v2/pods");
    expect(requests[0]?.request.method).toBe("POST");
    expect(requests[0]?.request.headers.get("Authorization")).toBe(
      `Bearer ${api_key}`,
    );
    expect(await requests[0]?.request.json()).toEqual({
      name: "example-pod",
      image: "example/workload:latest",
      cloud: "SECURE",
      gpu: { id: "Example GPU", count: 2 },
      disk: 40,
      dataCenterIds: ["example-region"],
      mounts: { persistent: { size: 10, path: "/workspace" } },
      ports: ["8888/http", "22/tcp"],
      startSsh: true,
    });
    expect(result.stdout + result.stderr).not.toContain(api_key);
  });

  test("routes Vast offer purchases through the adapter and returns an accepted contract", async () => {
    const { run, requests } = await fixture({
      vast: [Response.json({ success: true, new_contract: 201 })],
    });
    const result = await run([
      "--account",
      "vast",
      "instance",
      "buy",
      ...vast_create,
      "--label",
      "example-container",
      "--ssh",
      "--yes",
    ]);
    expect(result.exit_code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout).data).toEqual({
      provider_id: "vast",
      id: "201",
      status: "accepted",
      label: "example-container",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.request.url).toBe(
      "https://cloud.vast.ai/api/v0/asks/101/",
    );
    expect(requests[0]?.request.method).toBe("PUT");
    expect(await requests[0]?.request.json()).toEqual({
      client_id: "me",
      image: "example/workload:latest",
      disk: 20,
      runtype: "ssh",
      cancel_unavail: true,
      label: "example-container",
    });
    expect(result.stdout).not.toContain(api_key);
  });

  test("a declined GPU mutation does not resolve credentials or make requests", async () => {
    const { run, requests, connections } = await fixture();
    const result = await run(
      ["--account", "runpod", "instance", "create", ...runpod_create],
      { env: {}, is_interactive: true, confirmation: false },
    );
    expect(result.exit_code).toBe(0);
    expect(JSON.parse(result.stdout).data).toEqual({ status: "cancelled" });
    expect(result.confirmations).toHaveLength(1);
    expect(connections).toEqual([]);
    expect(requests).toEqual([]);
  });

  test("label edits retain accepted results without issuing a follow-up read", async () => {
    const { run, requests } = await fixture({
      runpod: [Response.json({ id: "pod-1" })],
      vast: [Response.json({ success: true })],
    });
    const runpod = await run([
      "--account",
      "runpod",
      "instance",
      "edit",
      "pod-1",
      "--label",
      "renamed-example",
      "--yes",
    ]);
    const vast = await run([
      "--account",
      "vast",
      "instance",
      "edit",
      "201",
      "--label",
      "renamed-example",
      "--yes",
    ]);
    expect(runpod.exit_code).toBe(0);
    expect(vast.exit_code).toBe(0);
    expect(JSON.parse(runpod.stdout).data).toEqual({
      provider_id: "runpod",
      id: "pod-1",
      status: "accepted",
      label: "renamed-example",
    });
    expect(JSON.parse(vast.stdout).data).toEqual({
      provider_id: "vast",
      id: "201",
      status: "accepted",
      label: "renamed-example",
    });
    expect(requests).toHaveLength(2);
    expect(requests.map(({ request }) => request.method)).toEqual([
      "PATCH",
      "PUT",
    ]);
    expect(await requests[0]?.request.json()).toEqual({
      name: "renamed-example",
    });
    expect(await requests[1]?.request.json()).toEqual({
      label: "renamed-example",
    });
  });

  test("maps offer-search flags through Vast and exposes only normalized offer fields", async () => {
    const { run, requests } = await fixture({
      vast: [
        Response.json({
          offers: [
            {
              id: 101,
              gpu_name: "Example GPU",
              num_gpus: 2,
              dph_total: 0.75,
              disk_space: 80,
              private_value: "unselected-fixture-field",
            },
          ],
        }),
      ],
    });
    const result = await run([
      "--account",
      "vast",
      "spec",
      "list",
      "offer",
      "--gpu",
      "Example GPU",
      "--gpu-count",
      "2",
      "--disk-gb",
      "40",
      "--limit",
      "5",
    ]);
    expect(result.exit_code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      account_id: "vast",
      provider_id: "vast",
      action: "spec.list.offer",
      data: [
        {
          id: "101",
          gpu_name: "Example GPU",
          gpu_count: 2,
          hourly_cost: 0.75,
          currency: "USD",
          disk_gb: 80,
        },
      ],
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.request.url).toBe(
      "https://cloud.vast.ai/api/v0/bundles/",
    );
    expect(requests[0]?.request.method).toBe("POST");
    expect(await requests[0]?.request.json()).toEqual({
      type: "ondemand",
      verified: { eq: true },
      rentable: { eq: true },
      rented: { eq: false },
      external: { eq: false },
      order: [["dph_total", "asc"]],
      limit: 5,
      gpu_name: { eq: "Example GPU" },
      num_gpus: { eq: 2 },
      allocated_storage: 40,
      disk_space: { gte: 40 },
    });
    expect(result.stdout).not.toContain("unselected-fixture-field");
    expect(result.stdout).not.toContain(api_key);
  });

  test("rejects excessive offer limits before connecting and unsupported offer searches before HTTP", async () => {
    const { run, requests, connections } = await fixture();
    const excessive = await run([
      "--account",
      "vast",
      "spec",
      "list",
      "offer",
      "--limit",
      "101",
    ]);
    expect(excessive.exit_code).toBe(1);
    expect(JSON.parse(excessive.stderr).error.code).toBe("invalid_input");
    expect(connections).toEqual([]);
    for (const provider_id of ["runpod", "vultr"]) {
      const result = await run([
        "--account",
        provider_id,
        "spec",
        "list",
        "offer",
      ]);
      expect(result.exit_code).toBe(1);
      expect(JSON.parse(result.stderr).error.code).toBe(
        "unsupported_operation",
      );
    }
    expect(requests).toEqual([]);
  });
});
