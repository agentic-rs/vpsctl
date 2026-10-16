import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/commands/program.ts";
import { AccountStore } from "../src/core/accounts.ts";
import { AppError } from "../src/core/errors.ts";
import { filterMachines } from "../src/core/machines.ts";
import type {
  MachineOffer,
  MachineQuery,
  ProviderDefinition,
} from "../src/core/provider.ts";
import { ProviderRegistry } from "../src/core/registry.ts";

const temp_dirs: string[] = [];
const machine: MachineOffer = {
  provider_id: "example",
  id: "example-plan",
  type: "shared_cpu",
  source: "plan",
  availability: "unknown",
  region_ids: ["example-region"],
  vcpu_count: 2,
  memory_mb: 2048,
  disk_gb: 40,
  monthly_cost: 6,
  currency: "USD",
};

async function fixture(supports_machines = true) {
  const temp_dir = await mkdtemp(join(tmpdir(), "vpsctl-machines-"));
  temp_dirs.push(temp_dir);
  const config_path = join(temp_dir, "config.json");
  const store = new AccountStore(config_path);
  const connections: string[] = [];
  const queries: { account_id: string; query: MachineQuery | undefined }[] = [];
  const failures = new Set<string>();
  const definition: ProviderDefinition = {
    info: {
      id: "example",
      name: "Example Provider",
      capabilities: ["machines"],
    },
    credential_fields: ["api_key"],
    create(credentials) {
      const account_id = credentials.api_key ?? "";
      connections.push(account_id);
      const unexpected = async (): Promise<never> => {
        throw new Error("Discovery must only call listMachines.");
      };
      return {
        info: definition.info,
        ...(supports_machines
          ? {
              async listMachines(query?: MachineQuery) {
                queries.push({ account_id, query });
                if (failures.has(account_id)) {
                  throw new AppError(
                    "provider_error",
                    "Example provider unavailable.",
                  );
                }
                return filterMachines([machine], query ?? {});
              },
            }
          : {}),
        listInstances: unexpected,
        getInstance: unexpected,
        createInstance: unexpected,
        editInstance: unexpected,
        startInstance: unexpected,
        stopInstance: unexpected,
        rebootInstance: unexpected,
        destroyInstance: unexpected,
        listRegions: unexpected,
        listPlans: unexpected,
        listImages: unexpected,
        listSshKeys: unexpected,
      };
    },
  };
  const registry = new ProviderRegistry([definition]);
  const addAccounts = async () => {
    for (const id of ["example-a", "example-b"]) {
      await store.add({
        id,
        provider_id: "example",
        credentials: { api_key: { source: "literal", value: id } },
      });
    }
    await store.use("example-a");
  };
  const run = async (
    args: string[],
    env: Readonly<Record<string, string | undefined>> = {},
  ) => {
    const output: string[] = [];
    const errors: string[] = [];
    const exit_code = await runCli(["--config", config_path, ...args], {
      registry,
      env,
      io: {
        write_out: (text) => output.push(text),
        write_err: (text) => errors.push(text),
        is_interactive: false,
        confirm: async () => {
          throw new Error("Discovery must not confirm purchases.");
        },
      },
    });
    return { exit_code, stdout: output.join(""), stderr: errors.join("") };
  };
  return {
    store,
    config_path,
    connections,
    queries,
    failures,
    addAccounts,
    run,
  };
}

afterEach(async () => {
  await Promise.all(
    temp_dirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("machine discovery CLI", () => {
  test("routes the selected account and preserves normalized JSON prices", async () => {
    const { addAccounts, run, queries } = await fixture();
    await addAccounts();
    const result = await run(["spec", "list", "machine", "--json"]);
    expect(result.exit_code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      account_id: "example-a",
      provider_id: "example",
      action: "spec.list.machine",
      data: [machine],
    });
    expect(queries).toEqual([{ account_id: "example-a", query: {} }]);
  });

  test.each([
    ["shared-cpu", "shared_cpu"],
    ["dedicated-cpu", "dedicated_cpu"],
    ["bare-metal", "bare_metal"],
    ["gpu", "gpu"],
  ] as const)(
    "maps the %s category to the provider contract",
    async (flag, type) => {
      const { addAccounts, run, queries } = await fixture();
      await addAccounts();
      const result = await run([
        "spec",
        "list",
        "machine",
        "--type",
        flag,
        "--json",
      ]);
      expect(result.exit_code).toBe(0);
      expect(queries).toEqual([{ account_id: "example-a", query: { type } }]);
    },
  );

  test("passes combined discovery filters and explicit account selection", async () => {
    const { addAccounts, run, queries } = await fixture();
    await addAccounts();
    const result = await run([
      "spec",
      "list",
      "machine",
      "--account",
      "example-b",
      "--type",
      "gpu",
      "--gpu",
      "Example GPU",
      "--gpu-count",
      "2",
      "--disk-gb",
      "40",
      "--limit",
      "10",
      "--region",
      "example-region",
      "--available",
      "--json",
    ]);
    expect(result.exit_code).toBe(0);
    expect(queries).toEqual([
      {
        account_id: "example-b",
        query: {
          type: "gpu",
          gpu_name: "Example GPU",
          gpu_count: 2,
          disk_gb: 40,
          limit: 10,
          region_id: "example-region",
          available_only: true,
        },
      },
    ]);
  });

  test("renders classification, stock, and currency within cost cells", async () => {
    const { addAccounts, run } = await fixture();
    await addAccounts();
    const result = await run(["spec", "list", "machine"]);
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain("Account: example-a (example)");
    expect(result.stdout).toContain("shared_cpu");
    expect(result.stdout).toContain("unknown");
    expect(result.stdout).toContain("$ 6");
    expect(result.stdout).not.toContain("currency");
  });

  test.each(["--all", "--all-accounts"])(
    "queries all accounts with %s and retains successful results",
    async (flag) => {
      const { addAccounts, run, queries, failures } = await fixture();
      await addAccounts();
      failures.add("example-b");
      const result = await run(["spec", "list", "machine", flag, "--json"]);
      expect(result.exit_code).toBe(1);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        action: "spec.list.machine",
        data: [
          {
            account_id: "example-a",
            provider_id: "example",
            machines: [machine],
          },
          {
            account_id: "example-b",
            provider_id: "example",
            error: "Example provider unavailable.",
          },
        ],
      });
      expect(queries.map((entry) => entry.account_id)).toEqual([
        "example-a",
        "example-b",
      ]);
    },
  );

  test("prints human account headers for empty filtered results and errors", async () => {
    const { addAccounts, run, failures } = await fixture();
    await addAccounts();
    failures.add("example-b");
    const result = await run([
      "spec",
      "list",
      "machine",
      "--all",
      "--available",
    ]);
    expect(result.exit_code).toBe(1);
    expect(result.stdout).toContain(
      "Account: example-a (example)\nNo results.",
    );
    expect(result.stdout).toContain(
      "Account: example-b (example)\nError: Example provider unavailable.",
    );
  });

  test("handles an empty account store without attempting connections", async () => {
    const { run, connections } = await fixture();
    const result = await run(["spec", "list", "machine", "--all", "--json"]);
    expect(result.exit_code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      action: "spec.list.machine",
      data: [],
    });
    expect((await run(["spec", "list", "machine", "--all"])).stdout).toContain(
      "No accounts configured.",
    );
    expect(connections).toEqual([]);
  });

  test("rejects conflicting all-account selection before connecting", async () => {
    const { addAccounts, run, connections } = await fixture();
    await addAccounts();
    for (const [args, env] of [
      [["--account", "example-a"], {}],
      [[], { VPSCTL_ACCOUNT: "example-b" }],
    ] as const) {
      const result = await run(
        ["spec", "list", "machine", "--all", "--json", ...args],
        env,
      );
      expect(result.exit_code).toBe(1);
      expect(JSON.parse(result.stderr).error.code).toBe("invalid_input");
    }
    expect(connections).toEqual([]);
  });

  test("rejects invalid filters before configuration reads or connections", async () => {
    const { config_path, run, connections } = await fixture();
    await mkdir(config_path);
    for (const args of [
      ["machine", "--type", "invalid"],
      ["machine", "--type", "bare-metal", "--gpu", "Example GPU"],
      ["machine", "--type", "dedicated-cpu", "--gpu-count", "1"],
      ["machine", "--region", " "],
      ["machine", "--gpu", " "],
      ["machine", "--gpu-count", "0"],
      ["machine", "--disk-gb", "1.5"],
      ["machine", "--limit", "101"],
      ...["region", "plan", "image", "offer"].flatMap((resource) => [
        [resource, "--type", "gpu"],
        [resource, "--available"],
        [resource, "--all"],
      ]),
    ]) {
      const result = await run(["spec", "list", ...args, "--json"]);
      expect(result.exit_code).toBe(1);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr).error.code).toBe("invalid_input");
    }
    expect(connections).toEqual([]);
  });

  test("reports a provider without discovery support without calling another resource", async () => {
    const { addAccounts, run, queries } = await fixture(false);
    await addAccounts();
    const result = await run(["spec", "list", "machine", "--json"]);
    expect(result.exit_code).toBe(1);
    expect(JSON.parse(result.stderr).error.code).toBe("unsupported_operation");
    expect(queries).toEqual([]);
  });
});
