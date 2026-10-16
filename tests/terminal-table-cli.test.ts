import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CliIO, runCli } from "../src/commands/program.ts";
import { AccountStore } from "../src/core/accounts.ts";
import type {
  Instance,
  MachineOffer,
  ProviderDefinition,
} from "../src/core/provider.ts";
import { ProviderRegistry } from "../src/core/registry.ts";

const temp_dirs: string[] = [];
const columns = 40;

async function fixture() {
  const temp_dir = await mkdtemp(join(tmpdir(), "vps-ctl-terminal-table-"));
  temp_dirs.push(temp_dir);
  const config_path = join(temp_dir, "config.json");
  const store = new AccountStore(config_path);
  for (const id of ["example-a", "example-b"]) {
    await store.add({
      id,
      provider_id: "example",
      credentials: { api_key: { source: "literal", value: "example-secret" } },
    });
  }
  await store.use("example-a");

  const instance: Instance = {
    provider_id: "example",
    id: "example-instance",
    label: "Example machine 世界",
    status: "running",
    region_id: "example-region",
    plan_id: "example-shared-plan",
    image_id: "example-image",
    provider_status: "active",
    power_status: "running",
    server_status: "ok",
    public_ipv4: "192.0.2.10",
    public_ipv6: "2001:db8::10",
    tags: ["example-tag"],
    monthly_cost: 6,
    currency: "USD",
  };
  const machine: MachineOffer = {
    provider_id: "example",
    id: "example-plan",
    name: "Example machine 世界",
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
  const definition: ProviderDefinition = {
    info: {
      id: "example",
      name: "Example Provider",
      capabilities: ["instances", "catalog", "machines", "ssh_keys"],
    },
    credential_fields: ["api_key"],
    create() {
      const unexpected = async (): Promise<never> => {
        throw new Error("Table listing must not change resources.");
      };
      return {
        info: definition.info,
        listInstances: async () => [instance],
        listMachines: async () => [machine],
        getInstance: unexpected,
        createInstance: unexpected,
        editInstance: unexpected,
        destroyInstance: unexpected,
        startInstance: unexpected,
        stopInstance: unexpected,
        rebootInstance: unexpected,
        listRegions: unexpected,
        listPlans: unexpected,
        listImages: unexpected,
        listSshKeys: unexpected,
      };
    },
  };
  const registry = new ProviderRegistry([definition]);
  const run = async (argv: string[], output_columns?: number) => {
    const output: string[] = [];
    const errors: string[] = [];
    const io: CliIO = {
      write_out: (text) => output.push(text),
      write_err: (text) => errors.push(text),
      is_interactive: false,
      ...(output_columns === undefined ? {} : { output_columns }),
      confirm: async () => {
        throw new Error("Table listing must not ask for confirmation.");
      },
    };
    const exit_code = await runCli(["--config", config_path, ...argv], {
      env: {},
      registry,
      io,
    });
    return { exit_code, stdout: output.join(""), stderr: errors.join("") };
  };
  return { run };
}

afterEach(async () => {
  await Promise.all(
    temp_dirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("terminal width across CLI list commands", () => {
  const commands = [
    ["provider", "list"],
    ["auth", "list"],
    ["instance", "list"],
    ["instance", "list", "--all"],
    ["spec", "list", "machine"],
    ["spec", "list", "machine", "--all"],
  ];

  test.each(commands.map((argv) => [argv]))(
    "bounds %j output independently of prompt interactivity",
    async (argv) => {
      const { run } = await fixture();
      const result = await run(argv, columns);
      expect(result.exit_code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Hidden fields:");
      expect(result.stdout).toContain("--json");
      for (const line of result.stdout.split("\n")) {
        expect(Bun.stringWidth(line)).toBeLessThanOrEqual(columns);
      }
    },
  );

  test.each(commands.map((argv) => [argv]))(
    "keeps %j JSON output independent of terminal width",
    async (argv) => {
      const { run } = await fixture();
      const unbounded = await run([...argv, "--json"]);
      const bounded = await run([...argv, "--json"], columns);
      expect(bounded.exit_code).toBe(0);
      expect(bounded.stderr).toBe("");
      expect(bounded.stdout).toBe(unbounded.stdout);
      expect(JSON.parse(bounded.stdout)).toHaveProperty("data");
    },
  );

  test.each(
    [
      ["instance", "list", "--all"],
      ["spec", "list", "machine", "--all"],
    ].map((argv) => [argv]),
  )("preserves every %j account section", async (argv) => {
    const { run } = await fixture();
    const result = await run(argv, columns);
    expect(result.exit_code).toBe(0);
    for (const id of ["example-a", "example-b"]) {
      expect(result.stdout).toContain(`Account: ${id} (example)`);
    }
    expect(result.stdout.match(/Hidden fields:/g)).toHaveLength(2);
  });

  test("uses complete columns when output width is unknown", async () => {
    const { run } = await fixture();
    const result = await run(["instance", "list"]);
    expect(result.exit_code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("Hidden fields:");
    expect(result.stdout).toContain("plan_id");
    expect(result.stdout).toContain("public_ipv4");
    expect(result.stdout).toContain("monthly_cost");
    expect(
      Math.max(
        ...result.stdout.split("\n").map((line) => Bun.stringWidth(line)),
      ),
    ).toBeGreaterThan(columns);
  });
});
