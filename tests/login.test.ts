import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CliIO, runCli } from "../src/commands/program.ts";
import { type Account, AccountStore } from "../src/core/accounts.ts";
import { AppError } from "../src/core/errors.ts";
import type { Instance, ProviderDefinition } from "../src/core/provider.ts";
import { ProviderRegistry } from "../src/core/registry.ts";

interface RunOptions {
  env?: Readonly<Record<string, string | undefined>>;
  is_interactive?: boolean;
  secret_input?: string;
  secret_error?: Error;
  stdin_input?: string;
  text_input?: string;
}

const temp_dirs: string[] = [];
const instances: Instance[] = [
  {
    provider_id: "vultr",
    id: "private-instance-id",
    label: "private-server-name",
    region_id: "nrt",
    plan_id: "vc2-1c-1gb",
    image_id: "2284",
    status: "running",
    provider_status: "active",
    power_status: "running",
    server_status: "ok",
    public_ipv4: "192.0.2.10",
    public_ipv6: "2001:db8::10",
    tags: [],
  },
];

function account(id: string, provider_id = "vultr"): Account {
  return {
    id,
    provider_id,
    credentials: { api_key: { source: "literal", value: "old-test-key" } },
  };
}

async function fixture() {
  const temp_dir = await mkdtemp(join(tmpdir(), "vps-ctl-login-"));
  temp_dirs.push(temp_dir);
  const config_path = join(temp_dir, "config.json");
  const store = new AccountStore(config_path);
  const connections: {
    provider_id: string;
    credentials: Readonly<Record<string, string>>;
  }[] = [];
  const list_calls: string[] = [];
  const state: {
    verification_error?: AppError;
    before_list?: () => Promise<void>;
    instances: Instance[];
  } = { instances };
  const unused = async (): Promise<never> => {
    throw new Error("Login must only list instances.");
  };
  const definitions: ProviderDefinition[] = ["vultr", "other"].map((id) => ({
    info: { id, name: `Test ${id}`, capabilities: ["instances"] },
    credential_fields: ["api_key"],
    create(credentials) {
      connections.push({ provider_id: id, credentials });
      return {
        info: this.info,
        async listInstances() {
          list_calls.push(id);
          await state.before_list?.();
          if (state.verification_error) throw state.verification_error;
          return state.instances;
        },
        getInstance: unused,
        createInstance: unused,
        editInstance: unused,
        destroyInstance: unused,
        startInstance: unused,
        stopInstance: unused,
        rebootInstance: unused,
        listRegions: unused,
        listPlans: unused,
        listImages: unused,
        listSshKeys: unused,
      };
    },
  }));
  const registry = new ProviderRegistry(definitions);
  const run = async (argv: string[], options: RunOptions = {}) => {
    const output: string[] = [];
    const errors: string[] = [];
    const secret_prompts: string[] = [];
    const text_prompts: string[] = [];
    let stdin_reads = 0;
    const io: CliIO = {
      write_out: (text) => output.push(text),
      write_err: (text) => errors.push(text),
      is_interactive: options.is_interactive ?? false,
      async confirm() {
        throw new Error("Login does not require mutation confirmation.");
      },
      async read_secret(message) {
        secret_prompts.push(message);
        if (options.secret_error) throw options.secret_error;
        return options.secret_input ?? "";
      },
      async read_stdin() {
        stdin_reads += 1;
        return options.stdin_input ?? "";
      },
      async read_text(message) {
        text_prompts.push(message);
        return options.text_input ?? "";
      },
    };
    const exit_code = await runCli(["--config", config_path, ...argv], {
      env: options.env ?? {},
      io,
      registry,
    });
    return {
      exit_code,
      stdout: output.join(""),
      stderr: errors.join(""),
      secret_prompts,
      stdin_reads,
      text_prompts,
    };
  };
  return { config_path, store, connections, list_calls, state, run };
}

afterEach(async () => {
  await Promise.all(
    temp_dirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("verified account login", () => {
  test("prompts for a missing account name before requesting its credentials", async () => {
    const { run, store, list_calls } = await fixture();
    const result = await run(["login", "--json"], {
      is_interactive: true,
      text_input: "personal",
      secret_input: "named-login-test-key",
    });
    expect(result.exit_code).toBe(0);
    expect(result.text_prompts).toHaveLength(1);
    expect(result.secret_prompts).toHaveLength(1);
    expect(list_calls).toEqual(["vultr"]);
    expect(JSON.parse(result.stdout).data.id).toBe("personal");
    expect((await store.read()).accounts[0]?.id).toBe("personal");
  });

  test("requires an explicit name noninteractively and validates a prompted name before reading secrets", async () => {
    const { run, config_path, connections } = await fixture();
    const missing = await run(["login", "--json"]);
    expect(missing.exit_code).toBe(1);
    expect(missing.text_prompts).toEqual([]);
    expect(missing.secret_prompts).toEqual([]);
    for (const text_input of ["", "../invalid"]) {
      const invalid = await run(["login", "--json"], {
        is_interactive: true,
        text_input,
      });
      expect(invalid.exit_code).toBe(1);
      expect(invalid.text_prompts).toHaveLength(1);
      expect(invalid.secret_prompts).toEqual([]);
    }
    expect(connections).toEqual([]);
    expect(await Bun.file(config_path).exists()).toBe(false);
  });

  test("prompts for a secret, verifies before saving, and prints only a safe summary", async () => {
    const { run, store, config_path, connections, list_calls, state } =
      await fixture();
    const secret = "interactive-login-test-key";
    state.before_list = async () => {
      expect(await Bun.file(config_path).exists()).toBe(false);
    };
    const result = await run(["login", "personal", "--json"], {
      is_interactive: true,
      secret_input: secret,
    });
    expect(result.exit_code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.secret_prompts).toHaveLength(1);
    expect(result.secret_prompts[0]).toContain("api_key");
    expect(result.stdin_reads).toBe(0);
    expect(connections).toEqual([
      { provider_id: "vultr", credentials: { api_key: secret } },
    ]);
    expect(list_calls).toEqual(["vultr"]);
    expect(JSON.parse(result.stdout)).toEqual({
      action: "login",
      data: {
        id: "personal",
        provider_id: "vultr",
        status: "authenticated",
        instance_count: 1,
      },
    });
    expect(result.stdout).not.toContain(secret);
    expect(result.stdout).not.toContain(instances[0]?.id ?? "");
    expect(result.stdout).not.toContain(instances[0]?.public_ipv4 ?? "");
    expect(await store.read()).toEqual({
      version: 1,
      accounts: [
        {
          id: "personal",
          provider_id: "vultr",
          credentials: { api_key: { source: "literal", value: secret } },
        },
      ],
    });
    const list_result = await run(["account", "list", "--json"]);
    expect(JSON.parse(list_result.stdout).data[0].credentials).toEqual({
      api_key: { source: "literal", value: "[redacted]" },
    });
    const human_list = await run(["account", "list"]);
    expect(human_list.exit_code).toBe(0);
    for (const output of [list_result, human_list]) {
      expect(output.stdout).not.toContain(secret);
      expect(output.stderr).not.toContain(secret);
    }
  });

  test("verifies environment references while saving only the reference", async () => {
    const { run, config_path, store, connections } = await fixture();
    const result = await run(
      ["login", "work", "--credential", "api_key=WORK_API_KEY", "--json"],
      { env: { WORK_API_KEY: "environment-login-test-key" } },
    );
    expect(result.exit_code).toBe(0);
    expect(result.secret_prompts).toEqual([]);
    expect(result.stdin_reads).toBe(0);
    expect(connections).toEqual([
      {
        provider_id: "vultr",
        credentials: { api_key: "environment-login-test-key" },
      },
    ]);
    expect((await store.read()).accounts[0]?.credentials).toEqual({
      api_key: { source: "env", name: "WORK_API_KEY" },
    });
    expect(await readFile(config_path, "utf8")).not.toContain(
      "environment-login-test-key",
    );
  });

  test("accepts piped credential JSON and authenticates accounts with no instances", async () => {
    const { run, store, state, list_calls } = await fixture();
    const secret = "piped-login-test-key";
    state.instances = [];
    const result = await run(
      [
        "login",
        "empty",
        "--provider",
        "vultr",
        "--credentials-stdin",
        "--json",
      ],
      { stdin_input: JSON.stringify({ api_key: secret }) },
    );
    expect(result.exit_code).toBe(0);
    expect(result.secret_prompts).toEqual([]);
    expect(result.stdin_reads).toBe(1);
    expect(list_calls).toEqual(["vultr"]);
    expect(JSON.parse(result.stdout).data).toMatchObject({
      status: "authenticated",
      instance_count: 0,
    });
    expect((await store.read()).accounts[0]?.credentials).toEqual({
      api_key: { source: "literal", value: secret },
    });
    expect(result.stdout).not.toContain(secret);
    expect(result.stderr).not.toContain(secret);
  });

  test("infers an existing provider and replaces credentials without changing the default or other accounts", async () => {
    const { run, store, config_path, connections, state } = await fixture();
    const unrelated = account("personal");
    await store.add(unrelated);
    await store.add(account("work", "other"));
    await store.use("work");
    const original = await readFile(config_path, "utf8");
    state.before_list = async () => {
      expect(await readFile(config_path, "utf8")).toBe(original);
    };
    const result = await run(["login", "work", "--json"], {
      is_interactive: true,
      secret_input: "renewed-login-test-key",
    });
    expect(result.exit_code).toBe(0);
    expect(connections).toEqual([
      {
        provider_id: "other",
        credentials: { api_key: "renewed-login-test-key" },
      },
    ]);
    expect(await store.read()).toEqual({
      version: 1,
      default_account_id: "work",
      accounts: [
        unrelated,
        {
          id: "work",
          provider_id: "other",
          credentials: {
            api_key: { source: "literal", value: "renewed-login-test-key" },
          },
        },
      ],
    });
  });

  test("rejected verification neither creates a config nor changes existing credentials", async () => {
    const { run, store, config_path, state, list_calls } = await fixture();
    state.verification_error = new AppError(
      "authentication",
      "Invalid API key.",
      401,
    );
    const attempt = () =>
      run(["login", "work", "--json"], {
        is_interactive: true,
        secret_input: "rejected-login-test-key",
      });
    const first = await attempt();
    expect(first.exit_code).toBe(1);
    expect(JSON.parse(first.stderr)).toMatchObject({
      error: { code: "authentication" },
    });
    expect(await Bun.file(config_path).exists()).toBe(false);
    await store.add(account("work"));
    await store.add(account("personal"));
    await store.use("work");
    const original = await readFile(config_path, "utf8");
    const renewal = await attempt();
    expect(renewal.exit_code).toBe(1);
    expect(await readFile(config_path, "utf8")).toBe(original);
    expect(list_calls).toEqual(["vultr", "vultr"]);
    for (const result of [first, renewal]) {
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toContain("rejected-login-test-key");
    }
  });

  test("rejects invalid IDs and provider mismatches before prompting or connecting", async () => {
    const { run, store, config_path, connections } = await fixture();
    await store.add(account("work"));
    const original = await readFile(config_path, "utf8");
    for (const argv of [
      ["login", "../invalid"],
      ["login", "a".repeat(65)],
      ["login", "work", "--provider", "other"],
      ["login", "new", "--provider", "missing"],
    ]) {
      const result = await run([...argv, "--json"], {
        is_interactive: true,
        secret_input: "must-not-read-test-key",
      });
      expect(result.exit_code).toBe(1);
      expect(result.secret_prompts).toEqual([]);
      expect(result.stdin_reads).toBe(0);
      expect(await readFile(config_path, "utf8")).toBe(original);
    }
    expect(connections).toEqual([]);
  });

  test("rejects malformed credential input before connecting or creating configuration", async () => {
    const { run, config_path, connections } = await fixture();
    const secret = "invalid-input-test-key";
    const inputs = [
      "{invalid JSON",
      JSON.stringify({}),
      JSON.stringify({ api_key: " " }),
      JSON.stringify({ api_key: secret, extra: secret }),
      JSON.stringify({ other: secret }),
      JSON.stringify({ api_key: 42 }),
      JSON.stringify([secret]),
    ];
    for (const stdin_input of inputs) {
      const result = await run(
        ["login", "work", "--credentials-stdin", "--json"],
        { stdin_input },
      );
      expect(result.exit_code).toBe(1);
      expect(JSON.parse(result.stderr).error.code).toBe("invalid_input");
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toContain(secret);
      expect(result.secret_prompts).toEqual([]);
    }
    expect(connections).toEqual([]);
    expect(await Bun.file(config_path).exists()).toBe(false);
  });

  test("rejects conflicting credential sources and missing environment values", async () => {
    const { run, config_path, connections } = await fixture();
    for (const flags of [
      ["--credential", "api_key=UNSET_API_KEY", "--credentials-stdin"],
      ["--credential", "api_key=UNSET_API_KEY"],
      ["--credential", "other=UNSET_API_KEY"],
      ["--credential", "api_key=invalid-name"],
    ]) {
      const result = await run(["login", "work", ...flags, "--json"]);
      expect(result.exit_code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.secret_prompts).toEqual([]);
      expect(result.stdin_reads).toBe(0);
    }
    expect(connections).toEqual([]);
    expect(await Bun.file(config_path).exists()).toBe(false);
  });

  test("requires interactive input or an explicit credential source", async () => {
    const { run, config_path, connections } = await fixture();
    const result = await run(["login", "work", "--json"]);
    expect(result.exit_code).toBe(1);
    expect(result.stderr).toContain("interactive terminal");
    expect(result.secret_prompts).toEqual([]);
    expect(connections).toEqual([]);
    expect(await Bun.file(config_path).exists()).toBe(false);
  });

  test("cancelled secret entry leaves stored credentials untouched", async () => {
    const { run, store, config_path, connections } = await fixture();
    await store.add(account("work"));
    const original = await readFile(config_path, "utf8");
    const cancelled = new Error("User cancelled the prompt.");
    cancelled.name = "ExitPromptError";
    const result = await run(["login", "work", "--json"], {
      is_interactive: true,
      secret_error: cancelled,
    });
    expect(result.exit_code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.secret_prompts).toHaveLength(1);
    expect(connections).toEqual([]);
    expect(await readFile(config_path, "utf8")).toBe(original);
  });
});
