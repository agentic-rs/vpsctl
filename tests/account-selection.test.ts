import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CliIO, runCli } from "../src/commands/program.ts";
import { type Account, AccountStore } from "../src/core/accounts.ts";
import { AppError } from "../src/core/errors.ts";
import type { ProviderDefinition } from "../src/core/provider.ts";
import { ProviderRegistry } from "../src/core/registry.ts";

interface RunOptions {
  env?: Readonly<Record<string, string | undefined>>;
  is_interactive?: boolean;
  select_available?: boolean;
  selected_id?: string;
  select_error?: Error;
}

const temp_dirs: string[] = [];
const work_id = "vultr:Work+sample@example.com";
const work_key = "selection-work-test-key";
const personal_key = "selection-personal-test-key";

function account(id: string, value: string): Account {
  return {
    id,
    provider_id: "vultr",
    credentials: { api_key: { source: "literal", value } },
  };
}

async function fixture() {
  const temp_dir = await mkdtemp(join(tmpdir(), "vpsctl-account-picker-"));
  temp_dirs.push(temp_dir);
  const config_path = join(temp_dir, "config.json");
  const store = new AccountStore(config_path);
  const calls: { action: string; api_key: string; instance_id?: string }[] = [];
  const connections: Readonly<Record<string, string>>[] = [];
  const unused = async (): Promise<never> => {
    throw new Error("Unexpected provider operation.");
  };
  const definition: ProviderDefinition = {
    info: { id: "vultr", name: "Test Vultr", capabilities: ["instances"] },
    credential_fields: ["api_key"],
    create(credentials) {
      connections.push(credentials);
      const api_key = credentials.api_key ?? "";
      return {
        info: this.info,
        async listInstances() {
          calls.push({ action: "list", api_key });
          return [];
        },
        async getAccountMetadata() {
          calls.push({ action: "metadata", api_key });
          return {
            provider_id: "vultr",
            name: "Test Account",
            email:
              api_key === work_key
                ? "Work+sample@example.com"
                : "personal@example.com",
            balance: 0,
            pending_charges: 0,
            last_payment_date: "2026-10-01",
            last_payment_amount: 5,
            currency: "USD",
            acls: ["instances"],
          };
        },
        async listRegions() {
          calls.push({ action: "regions", api_key });
          return [{ id: "nrt", name: "Tokyo", country: "JP" }];
        },
        async stopInstance(instance_id) {
          calls.push({ action: "stop", api_key, instance_id });
        },
        getInstance: unused,
        createInstance: unused,
        editInstance: unused,
        destroyInstance: unused,
        startInstance: unused,
        rebootInstance: unused,
        listPlans: unused,
        listImages: unused,
        listSshKeys: unused,
      };
    },
  };
  const registry = new ProviderRegistry([definition]);
  const run = async (argv: string[], options: RunOptions = {}) => {
    const output: string[] = [];
    const errors: string[] = [];
    const selections: {
      message: string;
      options: Parameters<NonNullable<CliIO["select"]>>[1];
    }[] = [];
    const io: CliIO = {
      write_out: (text) => output.push(text),
      write_err: (text) => errors.push(text),
      is_interactive: options.is_interactive ?? true,
      async confirm() {
        throw new Error("The test must explicitly authorize mutations.");
      },
      ...(options.select_available === false
        ? {}
        : {
            async select(
              message: string,
              choices: Parameters<NonNullable<CliIO["select"]>>[1],
            ) {
              selections.push({ message, options: choices });
              if (options.select_error) throw options.select_error;
              return options.selected_id ?? "personal";
            },
          }),
    };
    const exit_code = await runCli(["--config", config_path, ...argv], {
      io,
      registry,
      env: options.env ?? {},
    });
    return {
      exit_code,
      stdout: output.join(""),
      stderr: errors.join(""),
      selections,
    };
  };
  const addAccounts = async () => {
    await store.add(account(work_id, work_key));
    await store.add(account("personal", personal_key));
  };
  return { run, store, config_path, calls, connections, addAccounts };
}

afterEach(async () => {
  await Promise.all(
    temp_dirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("guided account selection", () => {
  test("selects an account for one query without changing the stored default", async () => {
    const { run, addAccounts, config_path, store, calls } = await fixture();
    await addAccounts();
    const original = await readFile(config_path, "utf8");
    const result = await run(["instance", "list"]);
    expect(result.exit_code).toBe(0);
    expect(result.selections).toHaveLength(1);
    expect(result.selections[0]?.options).toEqual([
      { value: work_id, label: work_id, hint: "vultr" },
      { value: "personal", label: "personal", hint: "vultr" },
    ]);
    expect(calls).toEqual([{ action: "list", api_key: personal_key }]);
    expect(result.stdout).toContain("Account: personal (vultr)");
    expect(await readFile(config_path, "utf8")).toBe(original);
    expect((await store.read()).default_account_id).toBeUndefined();
    for (const secret of [work_key, personal_key]) {
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });

  test("routes discovery, account metadata, and confirmed mutations through the selected account", async () => {
    const { run, addAccounts, calls } = await fixture();
    await addAccounts();
    for (const argv of [
      ["spec", "list", "region"],
      ["auth", "get"],
      ["instance", "stop", "vm-1", "--yes"],
    ]) {
      const result = await run(argv, { selected_id: work_id });
      expect(result.exit_code).toBe(0);
      expect(result.selections).toHaveLength(1);
      expect(result.stdout).toContain(`Account: ${work_id} (vultr)`);
    }
    expect(calls).toEqual([
      { action: "regions", api_key: work_key },
      { action: "metadata", api_key: work_key },
      { action: "stop", api_key: work_key, instance_id: "vm-1" },
    ]);
  });

  test("uses explicit, environment, and default accounts without opening a picker", async () => {
    const { run, addAccounts, store, calls } = await fixture();
    await addAccounts();
    await store.use("personal");
    for (const [argv, env] of [
      [
        ["--account", work_id, "instance", "list"],
        { VPSCTL_ACCOUNT: "personal" },
      ],
      [["instance", "list"], { VPSCTL_ACCOUNT: work_id }],
      [["instance", "list"], {}],
    ] as const) {
      const result = await run([...argv], {
        env,
        select_error: new AppError("cancelled", "Picker must not open."),
      });
      expect(result.exit_code).toBe(0);
      expect(result.selections).toEqual([]);
    }
    expect(calls.map(({ api_key }) => api_key)).toEqual([
      work_key,
      work_key,
      personal_key,
    ]);
  });

  test("retains strict account requirements for JSON, noninteractive, and unavailable picker modes", async () => {
    const { run, addAccounts, connections } = await fixture();
    await addAccounts();
    const results = [
      await run(["instance", "list", "--json"]),
      await run(["instance", "list"], { is_interactive: false }),
      await run(["instance", "list"], { select_available: false }),
    ];
    for (const result of results) {
      expect(result.exit_code).toBe(1);
      expect(result.selections).toEqual([]);
      expect(result.stderr).toContain("Select an account");
      expect(result.stdout).toBe("");
    }
    expect(connections).toEqual([]);
  });

  test.each(["--all", "--all-accounts"])(
    "bypasses account selection when querying every account with %s",
    async (flag) => {
      const { run, addAccounts, calls } = await fixture();
      await addAccounts();
      for (const argv of [
        ["instance", "list", flag],
        ["auth", "get", flag, "--json"],
      ]) {
        const result = await run(argv, {
          select_error: new AppError("cancelled", "Picker must not open."),
        });
        expect(result.exit_code).toBe(0);
        expect(result.selections).toEqual([]);
        expect(result.stdout).toContain(work_id);
        expect(result.stdout).toContain("personal");
      }
      expect(calls).toEqual([
        { action: "list", api_key: work_key },
        { action: "list", api_key: personal_key },
        { action: "metadata", api_key: work_key },
        { action: "metadata", api_key: personal_key },
      ]);
    },
  );

  test("cancelled selection leaves configuration untouched and makes no provider connection", async () => {
    const { run, addAccounts, config_path, connections } = await fixture();
    await addAccounts();
    const original = await readFile(config_path, "utf8");
    const result = await run(["instance", "list"], {
      select_error: new AppError("cancelled", "Operation cancelled."),
    });
    expect(result.exit_code).toBe(130);
    expect(result.selections).toHaveLength(1);
    expect(result.stdout).toBe("");
    expect(connections).toEqual([]);
    expect(await readFile(config_path, "utf8")).toBe(original);
  });

  test("does not open an empty picker when no accounts are configured", async () => {
    const { run, config_path, connections } = await fixture();
    const result = await run(["instance", "list"]);
    expect(result.exit_code).toBe(1);
    expect(result.selections).toEqual([]);
    expect(result.stderr).toContain("Select an account");
    expect(connections).toEqual([]);
    expect(await Bun.file(config_path).exists()).toBe(false);
  });
});
