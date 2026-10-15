import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CliIO, runCli } from "../src/commands/program.ts";
import { type Account, AccountStore } from "../src/core/accounts.ts";
import { AppError } from "../src/core/errors.ts";
import type {
  AccountMetadata,
  Provider,
  ProviderDefinition,
} from "../src/core/provider.ts";
import { ProviderRegistry } from "../src/core/registry.ts";

const temp_dirs: string[] = [];
const credentials = {
  WORK_TOKEN: "work-api-key-secret",
  PERSONAL_TOKEN: "personal-api-key-secret",
};
const work_metadata: AccountMetadata = {
  provider_id: "vultr",
  name: "Work team",
  email: "work@example.com",
  balance: -12.375,
  pending_charges: 1.005,
  last_payment_date: "2026-10-01 10:20:30",
  last_payment_amount: 20.125,
  currency: "USD",
  acls: ["billing", "subscriptions"],
};
const personal_metadata: AccountMetadata = {
  provider_id: "vultr",
  name: "Personal account",
  email: "personal@example.com",
  balance: 45.625,
  pending_charges: 0.005,
  last_payment_date: "",
  last_payment_amount: 0,
  currency: "USD",
  acls: [],
};

function account(
  id: string,
  credential_name: string,
  provider_id = "vultr",
): Account {
  return {
    id,
    provider_id,
    credentials: { api_key: { source: "env", name: credential_name } },
  };
}

async function fixture() {
  const temp_dir = await mkdtemp(join(tmpdir(), "vps-ctl-account-info-"));
  temp_dirs.push(temp_dir);
  const config_path = join(temp_dir, "config.json");
  const store = new AccountStore(config_path);
  const connections: { provider_id: string; api_key: string }[] = [];
  const calls: { action: string; api_key: string }[] = [];
  const failures = new Map<string, AppError>();
  const metadata_by_key = new Map([
    [credentials.WORK_TOKEN, work_metadata],
    [credentials.PERSONAL_TOKEN, personal_metadata],
  ]);
  const definition = (
    provider_id: string,
    supports_metadata: boolean,
  ): ProviderDefinition => {
    const info = { id: provider_id, name: provider_id, capabilities: [] };
    return {
      info,
      credential_fields: ["api_key"],
      create(resolved_credentials): Provider {
        const api_key = resolved_credentials.api_key ?? "";
        connections.push({ provider_id, api_key });
        const unexpected = async (): Promise<never> => {
          throw new Error("Unexpected provider operation.");
        };
        return {
          info,
          ...(supports_metadata
            ? {
                async getAccountMetadata() {
                  calls.push({ action: "metadata", api_key });
                  const failure = failures.get(api_key);
                  if (failure) throw failure;
                  const metadata = metadata_by_key.get(api_key);
                  if (!metadata) throw new Error("Unexpected credential.");
                  return metadata;
                },
              }
            : {}),
          async listInstances() {
            calls.push({ action: "instances", api_key });
            const failure = failures.get(api_key);
            if (failure) throw failure;
            return [];
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
    };
  };
  const registry = new ProviderRegistry([
    definition("vultr", true),
    definition("legacy", false),
  ]);
  const run = async (
    argv: string[],
    env: Readonly<Record<string, string | undefined>> = credentials,
  ) => {
    const output: string[] = [];
    const errors: string[] = [];
    const io: CliIO = {
      write_out: (text) => output.push(text),
      write_err: (text) => errors.push(text),
      is_interactive: false,
      async confirm() {
        throw new Error("Read-only metadata query must not prompt.");
      },
    };
    const exit_code = await runCli(["--config", config_path, ...argv], {
      env,
      io,
      registry,
    });
    return {
      exit_code,
      stdout: output.join(""),
      stderr: errors.join(""),
    };
  };
  const addAccounts = async () => {
    await store.add(account("work", "WORK_TOKEN"));
    await store.add(account("personal", "PERSONAL_TOKEN"));
    await store.use("work");
  };
  return { store, connections, calls, failures, run, addAccounts };
}

afterEach(async () => {
  await Promise.all(
    temp_dirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("selected account metadata", () => {
  test("queries the default account and preserves signed fractional amounts", async () => {
    const { run, addAccounts, calls } = await fixture();
    await addAccounts();
    const result = await run(["auth", "get", "--json"]);
    expect(result.exit_code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      action: "auth.get",
      account_id: "work",
      provider_id: "vultr",
      data: work_metadata,
    });
    expect(calls).toEqual([
      { action: "metadata", api_key: credentials.WORK_TOKEN },
    ]);
    for (const secret of Object.values(credentials)) {
      expect(result.stdout).not.toContain(secret);
      expect(result.stderr).not.toContain(secret);
    }
  });

  test("uses environment selection and lets an explicit account override it", async () => {
    const { run, addAccounts, connections } = await fixture();
    await addAccounts();
    const env = { ...credentials, VPS_CTL_ACCOUNT: "personal" };
    const selected = await run(["auth", "get", "--json"], env);
    const overridden = await run(
      ["auth", "get", "--account", "work", "--json"],
      env,
    );
    expect(selected.exit_code).toBe(0);
    expect(overridden.exit_code).toBe(0);
    expect(JSON.parse(selected.stdout)).toMatchObject({
      account_id: "personal",
      data: personal_metadata,
    });
    expect(JSON.parse(overridden.stdout)).toMatchObject({
      account_id: "work",
      data: work_metadata,
    });
    expect(connections).toEqual([
      { provider_id: "vultr", api_key: credentials.PERSONAL_TOKEN },
      { provider_id: "vultr", api_key: credentials.WORK_TOKEN },
    ]);
  });

  test("renders identity and balance as readable key-value fields", async () => {
    const { run, addAccounts } = await fixture();
    await addAccounts();
    const result = await run(["auth", "get"]);
    expect(result.exit_code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Account: work (vultr)\n");
    expect(result.stdout).toContain("email: work@example.com\n");
    expect(result.stdout).toContain("balance: -12.375\n");
    expect(result.stdout).toContain("pending_charges: 1.005\n");
    expect(result.stdout).toContain("currency: USD\n");
    expect(result.stdout).toContain('acls: ["billing","subscriptions"]\n');
    expect(result.stdout).not.toContain(credentials.WORK_TOKEN);
  });

  test("reports unsupported providers without invoking another provider operation", async () => {
    const { run, store, calls } = await fixture();
    await store.add(account("old", "WORK_TOKEN", "legacy"));
    const result = await run(["auth", "get", "--account", "old", "--json"]);
    expect(result.exit_code).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      error: {
        code: "unsupported_operation",
        message: "Provider 'legacy' does not support account metadata.",
      },
    });
    expect(calls).toEqual([]);
  });

  test("returns selected-account provider errors without successful metadata output", async () => {
    const { run, addAccounts, failures } = await fixture();
    await addAccounts();
    failures.set(
      credentials.WORK_TOKEN,
      new AppError("forbidden", "Account metadata access denied."),
    );
    const result = await run(["auth", "get", "--json"]);
    expect(result.exit_code).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      error: {
        code: "forbidden",
        message: "Account metadata access denied.",
      },
    });
  });

  test("requires only the selected account's credential", async () => {
    const { run, addAccounts, connections } = await fixture();
    await addAccounts();
    const result = await run(
      ["auth", "get", "--account", "personal", "--json"],
      { PERSONAL_TOKEN: credentials.PERSONAL_TOKEN },
    );
    expect(result.exit_code).toBe(0);
    expect(JSON.parse(result.stdout).data).toEqual(personal_metadata);
    expect(connections).toEqual([
      { provider_id: "vultr", api_key: credentials.PERSONAL_TOKEN },
    ]);
  });
});

describe("metadata across accounts", () => {
  test("retains each account's identity, metadata, and precise amounts in JSON", async () => {
    const { run, addAccounts, calls } = await fixture();
    await addAccounts();
    const result = await run(["auth", "get", "--all-accounts", "--json"]);
    expect(result.exit_code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      action: "auth.get",
      data: [
        { account_id: "work", provider_id: "vultr", metadata: work_metadata },
        {
          account_id: "personal",
          provider_id: "vultr",
          metadata: personal_metadata,
        },
      ],
    });
    expect(calls).toEqual([
      { action: "metadata", api_key: credentials.WORK_TOKEN },
      { action: "metadata", api_key: credentials.PERSONAL_TOKEN },
    ]);
    for (const secret of Object.values(credentials)) {
      expect(result.stdout).not.toContain(secret);
      expect(result.stderr).not.toContain(secret);
    }
  });

  test("renders separate readable metadata blocks for each account", async () => {
    const { run, addAccounts } = await fixture();
    await addAccounts();
    const result = await run(["auth", "get", "--all-accounts"]);
    expect(result.exit_code).toBe(0);
    expect(result.stderr).toBe("");
    const [work_output, personal_output] = result.stdout.split(
      "Account: personal (vultr)\n",
    );
    expect(work_output).toContain("Account: work (vultr)\n");
    expect(work_output).toContain("email: work@example.com\n");
    expect(work_output).toContain("balance: -12.375\n");
    expect(personal_output).toContain("email: personal@example.com\n");
    expect(personal_output).toContain("balance: 45.625\n");
    expect(personal_output).toContain("pending_charges: 0.005\n");
  });

  test("continues after a failed request and returns an account-scoped JSON error", async () => {
    const { run, addAccounts, failures, calls } = await fixture();
    await addAccounts();
    failures.set(
      credentials.WORK_TOKEN,
      new AppError("network_error", "Provider temporarily unavailable."),
    );
    const result = await run(["auth", "get", "--all-accounts", "--json"]);
    expect(result.exit_code).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      action: "auth.get",
      data: [
        {
          account_id: "work",
          provider_id: "vultr",
          error: "Provider temporarily unavailable.",
        },
        {
          account_id: "personal",
          provider_id: "vultr",
          metadata: personal_metadata,
        },
      ],
    });
    expect(calls).toHaveLength(2);
  });

  test("shows failed and successful accounts together in human output", async () => {
    const { run, addAccounts, failures } = await fixture();
    await addAccounts();
    failures.set(
      credentials.WORK_TOKEN,
      new AppError("forbidden", "Billing permission required."),
    );
    const result = await run(["auth", "get", "--all-accounts"]);
    expect(result.exit_code).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(
      "Account: work (vultr)\nError: Billing permission required.\n",
    );
    expect(result.stdout).toContain("Account: personal (vultr)\n");
    expect(result.stdout).toContain("email: personal@example.com\n");
  });

  test("handles unsupported providers independently of supported accounts", async () => {
    const { run, store, calls } = await fixture();
    await store.add(account("old", "WORK_TOKEN", "legacy"));
    await store.add(account("personal", "PERSONAL_TOKEN"));
    const result = await run(["auth", "get", "--all-accounts", "--json"]);
    expect(result.exit_code).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      action: "auth.get",
      data: [
        {
          account_id: "old",
          provider_id: "legacy",
          error: "Provider 'legacy' does not support account metadata.",
        },
        {
          account_id: "personal",
          provider_id: "vultr",
          metadata: personal_metadata,
        },
      ],
    });
    expect(calls).toEqual([
      { action: "metadata", api_key: credentials.PERSONAL_TOKEN },
    ]);
  });

  test("continues when one account's credential cannot be resolved", async () => {
    const { run, addAccounts, connections } = await fixture();
    await addAccounts();
    const result = await run(["auth", "get", "--all-accounts", "--json"], {
      PERSONAL_TOKEN: credentials.PERSONAL_TOKEN,
    });
    expect(result.exit_code).toBe(1);
    expect(result.stderr).toBe("");
    const payload = JSON.parse(result.stdout);
    expect(payload.data[0]).toMatchObject({
      account_id: "work",
      provider_id: "vultr",
    });
    expect(payload.data[0].error).toContain("WORK_TOKEN");
    expect(payload.data[0]).not.toHaveProperty("metadata");
    expect(payload.data[1]).toEqual({
      account_id: "personal",
      provider_id: "vultr",
      metadata: personal_metadata,
    });
    expect(connections).toEqual([
      { provider_id: "vultr", api_key: credentials.PERSONAL_TOKEN },
    ]);
  });

  test("rejects conflicting selectors before resolving credentials or connecting", async () => {
    const { run, addAccounts, connections, calls } = await fixture();
    await addAccounts();
    for (const result of [
      await run(
        ["auth", "get", "--all-accounts", "--account", "work", "--json"],
        {},
      ),
      await run(["auth", "get", "--all-accounts", "--json"], {
        VPS_CTL_ACCOUNT: "personal",
      }),
    ]) {
      expect(result.exit_code).toBe(1);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr)).toEqual({
        error: {
          code: "invalid_input",
          message:
            "--all-accounts cannot be combined with --account or VPS_CTL_ACCOUNT.",
        },
      });
    }
    expect(connections).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("returns empty results and a helpful human message without configured accounts or keys", async () => {
    const { run, connections, calls } = await fixture();
    const json_result = await run(
      ["auth", "get", "--all-accounts", "--json"],
      {},
    );
    const human_result = await run(["auth", "get", "--all-accounts"], {});
    expect(json_result.exit_code).toBe(0);
    expect(json_result.stderr).toBe("");
    expect(JSON.parse(json_result.stdout)).toEqual({
      action: "auth.get",
      data: [],
    });
    expect(human_result.exit_code).toBe(0);
    expect(human_result.stderr).toBe("");
    expect(human_result.stdout).toContain("No accounts configured.");
    expect(connections).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("keeps the existing inventory JSON envelope when using the shared account query", async () => {
    const { run, addAccounts, failures } = await fixture();
    await addAccounts();
    failures.set(
      credentials.PERSONAL_TOKEN,
      new AppError("network_error", "Inventory unavailable."),
    );
    const result = await run(["instance", "list", "--all-accounts", "--json"]);
    expect(result.exit_code).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      action: "instance.list",
      data: [
        { account_id: "work", provider_id: "vultr", instances: [] },
        {
          account_id: "personal",
          provider_id: "vultr",
          error: "Inventory unavailable.",
        },
      ],
    });
  });
});
