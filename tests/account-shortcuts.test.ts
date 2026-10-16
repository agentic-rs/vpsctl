import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CliIO, runCli } from "../src/commands/program.ts";
import { type Account, AccountStore } from "../src/core/accounts.ts";
import { AppError } from "../src/core/errors.ts";
import type { ProviderDefinition } from "../src/core/provider.ts";
import { ProviderRegistry } from "../src/core/registry.ts";

const temp_dirs: string[] = [];
const account_ids = {
  vultr: "vultr:alpha@example.invalid",
  runpod: "runpod:beta@example.invalid",
  vast: "vast:gamma@example.invalid",
} as const;

function account(id: string, provider_id: string): Account {
  return {
    id,
    provider_id,
    credentials: {
      api_key: { source: "literal", value: `synthetic-key-${id}` },
    },
  };
}

interface RunOptions {
  env?: Readonly<Record<string, string | undefined>>;
  selected_id?: string;
}

async function fixture() {
  const temp_dir = await mkdtemp(join(tmpdir(), "vpsctl-shortcuts-"));
  temp_dirs.push(temp_dir);
  const config_path = join(temp_dir, "config.json");
  const store = new AccountStore(config_path);
  const connections: string[] = [];
  const calls: { action: string; provider_id: string }[] = [];
  const failures = new Set<string>();
  const definitions = Object.keys(account_ids).map(
    (provider_id): ProviderDefinition => ({
      info: { id: provider_id, name: provider_id, capabilities: [] },
      credential_fields: ["api_key"],
      create() {
        connections.push(provider_id);
        const unexpected = async (): Promise<never> => {
          throw new Error("Unexpected provider operation.");
        };
        const record = (action: string) => {
          calls.push({ action, provider_id });
          if (failures.has(provider_id)) {
            throw new AppError("provider_error", "Synthetic provider failure.");
          }
        };
        return {
          info: this.info,
          async listInstances() {
            record("instances");
            return [];
          },
          async listMachines() {
            record("machines");
            return [];
          },
          async getAccountMetadata() {
            record("metadata");
            return {
              provider_id,
              email: "metadata@example.invalid",
              balance: 5,
              currency: "USD",
            };
          },
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
    }),
  );
  const registry = new ProviderRegistry(definitions);
  const selections: Parameters<NonNullable<CliIO["select"]>>[1][] = [];
  let confirmations = 0;
  const run = async (argv: string[], options: RunOptions = {}) => {
    const output: string[] = [];
    const errors: string[] = [];
    const exit_code = await runCli(["--config", config_path, ...argv], {
      env: options.env ?? {},
      registry,
      io: {
        write_out: (text) => output.push(text),
        write_err: (text) => errors.push(text),
        is_interactive: true,
        async select(_message, choices) {
          selections.push(choices);
          return options.selected_id ?? account_ids.vultr;
        },
        async confirm() {
          confirmations += 1;
          throw new Error(
            "Shortcut validation must finish before confirmation.",
          );
        },
      },
    });
    return { exit_code, stdout: output.join(""), stderr: errors.join("") };
  };
  const addAccounts = async () => {
    for (const [provider_id, id] of Object.entries(account_ids)) {
      await store.add(account(id, provider_id));
    }
  };
  return {
    store,
    config_path,
    run,
    addAccounts,
    connections,
    calls,
    failures,
    selections,
    confirmationCount: () => confirmations,
  };
}

afterEach(async () => {
  await Promise.all(
    temp_dirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("provider account shortcuts across CLI commands", () => {
  test("accepts explicit, short-option, and environment selectors without changing IDs", async () => {
    const { run, store, addAccounts, config_path, calls, selections } =
      await fixture();
    await addAccounts();
    const original = await readFile(config_path, "utf8");
    for (const [provider_id, args, env] of [
      ["vultr", ["--account", "vultr"], { VPSCTL_ACCOUNT: "vast" }],
      ["runpod", ["-a", "runpod"], {}],
      ["vast", [], { VPSCTL_ACCOUNT: "vast" }],
    ] as const) {
      const result = await run(["instance", "list", ...args, "--json"], {
        env,
      });
      expect(result.exit_code).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        account_id: account_ids[provider_id],
        provider_id,
        action: "instance.list",
        data: [],
      });
    }
    expect(calls.map(({ provider_id }) => provider_id)).toEqual([
      "vultr",
      "runpod",
      "vast",
    ]);
    expect(selections).toEqual([]);
    expect(await readFile(config_path, "utf8")).toBe(original);
    expect((await store.read()).default_account_id).toBeUndefined();
  });

  test("uses canonical IDs for mutation previews without provider connections", async () => {
    const { run, addAccounts, connections, confirmationCount } =
      await fixture();
    await addAccounts();
    const result = await run([
      "instance",
      "stop",
      "synthetic-instance",
      "--account",
      "vast",
      "--dry-run",
      "--json",
    ]);
    expect(result.exit_code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      action: "instance.stop",
      data: {
        account_id: account_ids.vast,
        provider_id: "vast",
        instance_id: "synthetic-instance",
        dry_run: true,
      },
    });
    const human = await run([
      "instance",
      "stop",
      "synthetic-instance",
      "-a",
      "vast",
      "--dry-run",
    ]);
    expect(human.exit_code).toBe(0);
    expect(human.stdout).toContain("account_id: vast\n");
    expect(human.stdout).not.toContain(account_ids.vast);
    expect(connections).toEqual([]);
    expect(confirmationCount()).toBe(0);
  });

  test("stores and reports the canonical default when auth use receives a shortcut", async () => {
    const { run, addAccounts, store } = await fixture();
    await addAccounts();
    const result = await run(["auth", "use", "runpod", "--json"]);
    expect(result.exit_code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      action: "auth.use",
      data: { default_account_id: account_ids.runpod },
    });
    expect((await store.read()).default_account_id).toBe(account_ids.runpod);
    const selected = await run(["instance", "list"]);
    expect(selected.exit_code).toBe(0);
    expect(selected.stdout).toContain("Account: runpod (runpod)\n");
    expect(selected.stdout).not.toContain(account_ids.runpod);
  });

  test("removes only the resolved account and clears its canonical default", async () => {
    const { run, addAccounts, store, connections } = await fixture();
    await addAccounts();
    await store.use(account_ids.vast);
    const result = await run(["auth", "remove", "vast", "--json"]);
    expect(result.exit_code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      action: "auth.remove",
      data: { removed_account_id: account_ids.vast },
    });
    const config = await store.read();
    expect(config.accounts.map(({ id }) => id)).toEqual([
      account_ids.vultr,
      account_ids.runpod,
    ]);
    expect(config.default_account_id).toBeUndefined();
    expect(connections).toEqual([]);
  });

  test("shortens human auth list IDs while preserving canonical JSON and redacting credentials", async () => {
    const { run, addAccounts } = await fixture();
    await addAccounts();
    const human = await run(["auth", "list"]);
    const json = await run(["auth", "list", "--json"]);
    expect(human.exit_code).toBe(0);
    expect(json.exit_code).toBe(0);
    expect(
      JSON.parse(json.stdout).data.map(({ id }: { id: string }) => id),
    ).toEqual(Object.values(account_ids));
    for (const [provider_id, id] of Object.entries(account_ids)) {
      expect(human.stdout).toContain(provider_id);
      expect(human.stdout).not.toContain(id);
      expect(human.stdout).not.toContain("synthetic-key-");
      expect(json.stdout).not.toContain("synthetic-key-");
    }
  });

  test("shows provider labels in the picker while retaining canonical option values", async () => {
    const { run, addAccounts, store, selections, calls } = await fixture();
    await addAccounts();
    const result = await run(["instance", "list"], {
      selected_id: account_ids.vast,
    });
    expect(result.exit_code).toBe(0);
    expect(selections).toHaveLength(1);
    expect(
      selections[0]?.map(({ value, label }) => ({ value, label })),
    ).toEqual(
      Object.entries(account_ids).map(([label, value]) => ({ value, label })),
    );
    expect(calls).toEqual([{ action: "instances", provider_id: "vast" }]);
    expect(result.stdout).toContain("Account: vast (vast)\n");
    expect((await store.read()).default_account_id).toBeUndefined();
  });

  test.each(
    [
      ["instance", "list"],
      ["spec", "list", "machine"],
      ["auth", "get"],
    ].map((args) => [args]),
  )("shortens selected and all-account human headers for %j", async (args) => {
    const { run, addAccounts, failures } = await fixture();
    await addAccounts();
    const selected = await run([...args, "--account", "vultr"]);
    expect(selected.exit_code).toBe(0);
    expect(selected.stdout).toContain("Account: vultr (vultr)\n");
    expect(selected.stdout).not.toContain(account_ids.vultr);
    failures.add("runpod");
    const all = await run([...args, "--all"]);
    expect(all.exit_code).toBe(1);
    for (const [provider_id, id] of Object.entries(account_ids)) {
      expect(all.stdout).toContain(
        `Account: ${provider_id} (${provider_id})\n`,
      );
      expect(all.stdout).not.toContain(id);
    }
    expect(all.stdout).toContain("Error: Synthetic provider failure.");
    const json = await run([...args, "--all", "--json"]);
    expect(json.exit_code).toBe(1);
    expect(
      JSON.parse(json.stdout).data.map(
        ({ account_id }: { account_id: string }) => account_id,
      ),
    ).toEqual(Object.values(account_ids));
  });

  test("rejects ambiguous shortcuts before connecting, prompting, or changing configuration", async () => {
    const {
      run,
      addAccounts,
      store,
      config_path,
      connections,
      selections,
      confirmationCount,
    } = await fixture();
    await addAccounts();
    await store.add(account("vultr:delta@example.invalid", "vultr"));
    const original = await readFile(config_path, "utf8");
    for (const args of [
      ["instance", "list", "--account", "vultr"],
      ["instance", "stop", "synthetic-instance", "-a", "vultr"],
      ["auth", "use", "vultr"],
      ["auth", "remove", "vultr"],
    ]) {
      const result = await run([...args, "--json"]);
      expect(result.exit_code).toBe(1);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr).error).toMatchObject({
        code: "invalid_input",
        message: expect.stringContaining("ambiguous"),
      });
    }
    expect(connections).toEqual([]);
    expect(selections).toEqual([]);
    expect(confirmationCount()).toBe(0);
    expect(await readFile(config_path, "utf8")).toBe(original);
    const listing = await run(["auth", "list"]);
    expect(listing.stdout).toContain(account_ids.vultr);
    expect(listing.stdout).toContain("vultr:delta@example.invalid");
  });
});
