import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CliIO, runCli } from "../src/commands/program.ts";
import { type Account, AccountStore } from "../src/core/accounts.ts";
import { AppError } from "../src/core/errors.ts";
import type {
  AccountMetadata,
  Instance,
  ProviderDefinition,
  ProviderRequestOptions,
} from "../src/core/provider.ts";
import { ProviderRegistry } from "../src/core/registry.ts";

interface RunOptions {
  env?: Readonly<Record<string, string | undefined>>;
  is_interactive?: boolean;
  secret_input?: string;
  secret_error?: Error;
  stdin_input?: string;
  text_input?: string;
  select_input?: string;
  select_error?: Error;
  guided_ui?: boolean;
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
  const temp_dir = await mkdtemp(join(tmpdir(), "vpsctl-login-"));
  temp_dirs.push(temp_dir);
  const config_path = join(temp_dir, "config.json");
  const store = new AccountStore(config_path);
  const connections: {
    provider_id: string;
    credentials: Readonly<Record<string, string>>;
  }[] = [];
  const list_calls: string[] = [];
  const metadata_calls: string[] = [];
  const request_signals: (AbortSignal | undefined)[] = [];
  const state: {
    verification_error?: AppError;
    metadata_error?: AppError;
    metadata_supported: boolean;
    email: string;
    before_metadata?: () => Promise<void>;
    before_list?: () => Promise<void>;
    progress_controller?: AbortController;
    instances: Instance[];
  } = {
    instances,
    email: "Tester.Name+sample@example.com",
    metadata_supported: true,
  };
  const unused = async (): Promise<never> => {
    throw new Error("Login must only query account metadata and instances.");
  };
  const definitions: ProviderDefinition[] = ["vultr", "other"].map((id) => ({
    info: { id, name: `Test ${id}`, capabilities: ["instances"] },
    credential_fields: ["api_key"],
    create(credentials) {
      connections.push({ provider_id: id, credentials });
      return {
        info: this.info,
        ...(state.metadata_supported
          ? {
              async getAccountMetadata(
                options?: ProviderRequestOptions,
              ): Promise<AccountMetadata> {
                metadata_calls.push(id);
                request_signals.push(options?.signal);
                await state.before_metadata?.();
                if (state.metadata_error) throw state.metadata_error;
                return {
                  provider_id: id,
                  name: "Test Account",
                  email: state.email,
                  balance: 0,
                  pending_charges: 3,
                  last_payment_date: "2026-10-01",
                  last_payment_amount: 5,
                  currency: "USD",
                  acls: ["instances"],
                };
              },
            }
          : {}),
        async listInstances(options) {
          list_calls.push(id);
          request_signals.push(options?.signal);
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
    const select_prompts: {
      message: string;
      options: Parameters<NonNullable<CliIO["select"]>>[1];
    }[] = [];
    const guided_events: { type: string; message: string }[] = [];
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
      async select(message, choices) {
        select_prompts.push({ message, options: choices });
        if (options.select_error) throw options.select_error;
        return options.select_input ?? choices[0]?.value ?? "";
      },
      ...(options.guided_ui
        ? {
            intro(message: string) {
              guided_events.push({ type: "intro", message });
            },
            outro(message: string) {
              guided_events.push({ type: "outro", message });
            },
            note(message: string) {
              guided_events.push({ type: "note", message });
            },
            progress(message: string) {
              guided_events.push({ type: "progress", message });
              const controller = new AbortController();
              state.progress_controller = controller;
              return {
                signal: controller.signal,
                stop(message: string) {
                  guided_events.push({ type: "stop", message });
                },
                fail(message: string) {
                  guided_events.push({ type: "fail", message });
                },
              };
            },
          }
        : {}),
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
      select_prompts,
      guided_events,
    };
  };
  return {
    config_path,
    store,
    connections,
    list_calls,
    metadata_calls,
    request_signals,
    state,
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

describe("verified account login", () => {
  test("refreshes a unique provider shortcut under its existing canonical ID", async () => {
    const { run, store, state, connections, metadata_calls } = await fixture();
    const id = `other:${state.email}`;
    await store.add(account(id, "other"));
    await store.use(id);
    const result = await run(
      ["auth", "login", "other", "--credentials-stdin", "--json"],
      {
        stdin_input: JSON.stringify({ api_key: "refreshed-shortcut-key" }),
      },
    );
    expect(result.exit_code).toBe(0);
    expect(result.select_prompts).toEqual([]);
    expect(metadata_calls).toEqual(["other"]);
    expect(connections).toEqual([
      {
        provider_id: "other",
        credentials: { api_key: "refreshed-shortcut-key" },
      },
    ]);
    expect(JSON.parse(result.stdout)).toEqual({
      action: "auth.login",
      data: {
        id,
        provider_id: "other",
        status: "authenticated",
        instance_count: 1,
      },
    });
    expect(await store.read()).toEqual({
      version: 1,
      default_account_id: id,
      accounts: [
        {
          id,
          provider_id: "other",
          credentials: {
            api_key: { source: "literal", value: "refreshed-shortcut-key" },
          },
        },
      ],
    });
  });

  test("rejects shortcut login credentials for a different verified identity", async () => {
    const { run, store, state, config_path, list_calls } = await fixture();
    await store.add(account("vultr:expected@example.invalid"));
    const original = await readFile(config_path, "utf8");
    state.email = "different@example.invalid";
    const result = await run(
      ["auth", "login", "vultr", "--credentials-stdin", "--json"],
      {
        stdin_input: JSON.stringify({ api_key: "rejected-shortcut-key" }),
      },
    );
    expect(result.exit_code).toBe(1);
    expect(JSON.parse(result.stderr).error.code).toBe("conflict");
    expect(list_calls).toEqual([]);
    expect(await readFile(config_path, "utf8")).toBe(original);
    expect(result.stderr).not.toContain("rejected-shortcut-key");
  });

  test("rejects ambiguous login shortcuts before reading or verifying credentials", async () => {
    const { run, store, config_path, connections } = await fixture();
    await store.add(account("vultr:first@example.invalid"));
    await store.add(account("vultr:second@example.invalid"));
    const original = await readFile(config_path, "utf8");
    const result = await run(
      ["auth", "login", "vultr", "--credentials-stdin", "--json"],
      {
        stdin_input: JSON.stringify({ api_key: "must-not-read-shortcut-key" }),
      },
    );
    expect(result.exit_code).toBe(1);
    expect(JSON.parse(result.stderr).error.message).toContain("ambiguous");
    expect(result.stdin_reads).toBe(0);
    expect(result.secret_prompts).toEqual([]);
    expect(result.select_prompts).toEqual([]);
    expect(connections).toEqual([]);
    expect(await readFile(config_path, "utf8")).toBe(original);
  });

  test("guided login shows the provider shortcut while saving the full derived ID", async () => {
    const { run, store, state } = await fixture();
    const result = await run(["auth", "login", "--provider", "vultr"], {
      is_interactive: true,
      secret_input: "guided-shortcut-key",
      guided_ui: true,
    });
    expect(result.exit_code).toBe(0);
    expect(result.guided_events).toContainEqual({
      type: "note",
      message: "Account ID: vultr\nInstances: 1",
    });
    expect((await store.read()).accounts[0]?.id).toBe(`vultr:${state.email}`);
    expect(JSON.stringify(result)).not.toContain("guided-shortcut-key");
  });

  test("derives an omitted ID from verified metadata without asking for an account name", async () => {
    const { run, store, list_calls, metadata_calls, state } = await fixture();
    const result = await run(["auth", "login", "--json"], {
      is_interactive: true,
      secret_input: "named-login-test-key",
      guided_ui: true,
    });
    expect(result.exit_code).toBe(0);
    expect(result.text_prompts).toEqual([]);
    expect(result.secret_prompts).toHaveLength(1);
    expect(list_calls).toEqual(["vultr"]);
    expect(metadata_calls).toEqual(["vultr"]);
    expect(JSON.parse(result.stdout).data.id).toBe(`vultr:${state.email}`);
    expect((await store.read()).accounts[0]?.id).toBe(`vultr:${state.email}`);
    expect(result.select_prompts).toEqual([]);
    expect(result.guided_events).toEqual([]);
    expect(result.stderr).toBe("");
  });

  test("derives an omitted ID noninteractively from piped credentials", async () => {
    const { run, store, metadata_calls, state } = await fixture();
    const result = await run(
      ["auth", "login", "--credentials-stdin", "--json"],
      {
        stdin_input: JSON.stringify({ api_key: "piped-derived-id-key" }),
      },
    );
    expect(result.exit_code).toBe(0);
    expect(result.text_prompts).toEqual([]);
    expect(result.secret_prompts).toEqual([]);
    expect(result.select_prompts).toEqual([]);
    expect(result.stdin_reads).toBe(1);
    expect(metadata_calls).toEqual(["vultr"]);
    expect((await store.read()).accounts[0]?.id).toBe(`vultr:${state.email}`);
    expect(result.stdout).not.toContain("piped-derived-id-key");
  });

  test("guides interactive login through provider selection and safe progress", async () => {
    const { run, store, connections, metadata_calls, state } = await fixture();
    const secret = "guided-provider-login-key";
    const result = await run(["auth", "login"], {
      is_interactive: true,
      select_input: "other",
      secret_input: secret,
      guided_ui: true,
    });
    expect(result.exit_code).toBe(0);
    expect(result.text_prompts).toEqual([]);
    expect(result.select_prompts).toHaveLength(1);
    expect(result.select_prompts[0]?.options).toEqual([
      { value: "vultr", label: "Test vultr", hint: "vultr" },
      { value: "other", label: "Test other", hint: "other" },
    ]);
    expect(connections).toEqual([
      { provider_id: "other", credentials: { api_key: secret } },
    ]);
    expect(metadata_calls).toEqual(["other"]);
    expect((await store.read()).accounts[0]?.id).toBe(`other:${state.email}`);
    const event_types = result.guided_events.map(({ type }) => type);
    expect(event_types).toContain("intro");
    expect(event_types).toContain("progress");
    expect(event_types).toContain("stop");
    expect(event_types).toContain("outro");
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  test("uses the chosen provider for interactive environment credential references", async () => {
    const { run, store, connections, metadata_calls, state } = await fixture();
    const secret = "environment-provider-key";
    const result = await run(
      ["auth", "login", "--credential", "api_key=OTHER_TOKEN"],
      {
        is_interactive: true,
        select_input: "other",
        env: { OTHER_TOKEN: secret },
        guided_ui: true,
      },
    );
    expect(result.exit_code).toBe(0);
    expect(result.select_prompts).toHaveLength(1);
    expect(result.select_prompts[0]?.message).toBe("Choose a provider");
    expect(result.secret_prompts).toEqual([]);
    expect(result.stdin_reads).toBe(0);
    expect(connections).toEqual([
      { provider_id: "other", credentials: { api_key: secret } },
    ]);
    expect(metadata_calls).toEqual(["other"]);
    expect((await store.read()).accounts).toEqual([
      {
        id: `other:${state.email}`,
        provider_id: "other",
        credentials: { api_key: { source: "env", name: "OTHER_TOKEN" } },
      },
    ]);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  test("does not ask for a provider when it is explicit or the input is scripted", async () => {
    const { run } = await fixture();
    for (const { argv, is_interactive } of [
      {
        argv: ["auth", "login", "named", "--provider", "other"],
        is_interactive: true,
      },
      { argv: ["auth", "login", "--credentials-stdin"], is_interactive: true },
      {
        argv: [
          "auth",
          "login",
          "--credential",
          "api_key=VULTR_TOKEN",
          "--json",
        ],
        is_interactive: true,
      },
      {
        argv: ["auth", "login", "--credential", "api_key=VULTR_TOKEN"],
        is_interactive: false,
      },
    ]) {
      const result = await run(argv, {
        is_interactive,
        select_input: "missing-provider",
        secret_input: "explicit-provider-key",
        stdin_input: JSON.stringify({ api_key: "piped-provider-key" }),
        env: { VULTR_TOKEN: "environment-provider-key" },
      });
      expect(result.exit_code).toBe(0);
      expect(result.select_prompts).toEqual([]);
    }
  });

  test("does not ask for a provider when an existing account or canonical ID identifies it", async () => {
    const { run, store, state, connections } = await fixture();
    await store.add(account("existing", "other"));
    for (const id of ["existing", `other:${state.email}`]) {
      const result = await run(["auth", "login", id], {
        is_interactive: true,
        select_input: "must-not-select-provider",
        secret_input: "inferred-provider-key",
      });
      expect(result.exit_code).toBe(0);
      expect(result.select_prompts).toEqual([]);
      expect(result.secret_prompts).toEqual(["Test other API key"]);
    }
    expect(connections).toEqual([
      {
        provider_id: "other",
        credentials: { api_key: "inferred-provider-key" },
      },
      {
        provider_id: "other",
        credentials: { api_key: "inferred-provider-key" },
      },
    ]);
  });

  test("requires metadata for derived IDs while preserving aliases for providers without it", async () => {
    const { run, config_path, store, state, metadata_calls } = await fixture();
    state.metadata_supported = false;
    const derived = await run(
      ["auth", "login", "--credentials-stdin", "--json"],
      {
        stdin_input: JSON.stringify({ api_key: "unsupported-metadata-key" }),
      },
    );
    expect(derived.exit_code).toBe(1);
    expect(JSON.parse(derived.stderr).error.code).toBe("unsupported_operation");
    expect(await Bun.file(config_path).exists()).toBe(false);
    expect(derived.stdout).toBe("");
    expect(derived.stderr).not.toContain("unsupported-metadata-key");
    const alias = await run(
      ["auth", "login", "work", "--credentials-stdin", "--json"],
      {
        stdin_input: JSON.stringify({ api_key: "supported-alias-key" }),
      },
    );
    expect(alias.exit_code).toBe(0);
    expect((await store.read()).accounts[0]?.id).toBe("work");
    expect(metadata_calls).toEqual([]);
  });

  test("does not save an automatic account after metadata, email, or inventory verification fails", async () => {
    const { run, state, config_path } = await fixture();
    const attempt = () =>
      run(["auth", "login", "--credentials-stdin", "--json"], {
        stdin_input: JSON.stringify({ api_key: "failed-automatic-login-key" }),
      });
    state.metadata_error = new AppError("authentication", "Metadata denied.");
    const denied = await attempt();
    expect(denied.exit_code).toBe(1);
    expect(await Bun.file(config_path).exists()).toBe(false);
    delete state.metadata_error;
    state.email = "   ";
    const blank_email = await attempt();
    expect(blank_email.exit_code).toBe(1);
    expect(await Bun.file(config_path).exists()).toBe(false);
    state.email = "valid@example.com";
    state.verification_error = new AppError(
      "network_error",
      "Inventory unavailable.",
    );
    const list_failed = await attempt();
    expect(list_failed.exit_code).toBe(1);
    expect(await Bun.file(config_path).exists()).toBe(false);
    for (const result of [denied, blank_email, list_failed]) {
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toContain("failed-automatic-login-key");
    }
  });

  test("protects an explicit provider and email ID from credentials belonging to another email", async () => {
    const { run, store, state, config_path, metadata_calls } = await fixture();
    const id = "vultr:expected@example.com";
    await store.add(account(id));
    await store.use(id);
    const original = await readFile(config_path, "utf8");
    state.email = "someone.else@example.com";
    const rejected = await run(
      ["auth", "login", id, "--credentials-stdin", "--json"],
      {
        stdin_input: JSON.stringify({ api_key: "different-account-key" }),
      },
    );
    expect(rejected.exit_code).toBe(1);
    expect(metadata_calls).toEqual(["vultr"]);
    expect(await readFile(config_path, "utf8")).toBe(original);
    expect(rejected.stdout).toBe("");
    expect(rejected.stderr).not.toContain("different-account-key");
    state.email = "expected@example.com";
    const matching = await run(
      ["auth", "login", id, "--credentials-stdin", "--json"],
      {
        stdin_input: JSON.stringify({ api_key: "matching-account-key" }),
      },
    );
    expect(matching.exit_code).toBe(0);
    expect((await store.read()).accounts[0]?.credentials.api_key).toEqual({
      source: "literal",
      value: "matching-account-key",
    });
    expect((await store.read()).default_account_id).toBe(id);
  });

  test("infers a new canonical ID's provider and rejects a conflicting provider before reading secrets", async () => {
    const { run, store, state, connections } = await fixture();
    const id = `other:${state.email}`;
    const conflicting = await run(
      ["auth", "login", id, "--provider", "vultr", "--json"],
      {
        is_interactive: true,
        secret_input: "must-not-read-key",
      },
    );
    expect(conflicting.exit_code).toBe(1);
    expect(conflicting.secret_prompts).toEqual([]);
    expect(connections).toEqual([]);
    const matching = await run(["auth", "login", id, "--json"], {
      is_interactive: true,
      secret_input: "canonical-other-provider-key",
    });
    expect(matching.exit_code).toBe(0);
    expect(matching.select_prompts).toEqual([]);
    expect(connections).toEqual([
      {
        provider_id: "other",
        credentials: { api_key: "canonical-other-provider-key" },
      },
    ]);
    expect((await store.read()).accounts[0]?.id).toBe(id);
  });

  test("renews a derived account while preserving its default and unrelated aliases", async () => {
    const { run, store, state } = await fixture();
    const id = `vultr:${state.email}`;
    const unrelated = account("personal");
    await store.add(account(id));
    await store.add(unrelated);
    await store.use(id);
    const result = await run(
      ["auth", "login", "--credentials-stdin", "--json"],
      {
        stdin_input: JSON.stringify({ api_key: "renewed-derived-account-key" }),
      },
    );
    expect(result.exit_code).toBe(0);
    expect(await store.read()).toEqual({
      version: 1,
      default_account_id: id,
      accounts: [
        {
          id,
          provider_id: "vultr",
          credentials: {
            api_key: {
              source: "literal",
              value: "renewed-derived-account-key",
            },
          },
        },
        unrelated,
      ],
    });
  });

  test("cancelled provider selection stops before reading secrets or creating configuration", async () => {
    const { run, config_path, connections } = await fixture();
    const result = await run(["auth", "login"], {
      is_interactive: true,
      guided_ui: true,
      select_error: new AppError("cancelled", "Operation cancelled."),
    });
    expect(result.exit_code).toBe(130);
    expect(result.select_prompts).toHaveLength(1);
    expect(result.secret_prompts).toEqual([]);
    expect(connections).toEqual([]);
    expect(await Bun.file(config_path).exists()).toBe(false);
  });

  test("cancelled verification propagates its signal and saves no credentials", async () => {
    const { run, state, request_signals, config_path } = await fixture();
    state.before_list = async () => {
      state.progress_controller?.abort(
        new AppError("cancelled", "Operation cancelled."),
      );
    };
    const result = await run(["auth", "login", "--provider", "vultr"], {
      is_interactive: true,
      guided_ui: true,
      secret_input: "cancelled-verification-key",
    });
    expect(result.exit_code).toBe(130);
    expect(state.progress_controller?.signal.aborted).toBe(true);
    expect(request_signals.length).toBeGreaterThan(0);
    expect(
      request_signals.every(
        (signal) => signal === state.progress_controller?.signal,
      ),
    ).toBe(true);
    expect(await Bun.file(config_path).exists()).toBe(false);
    expect(JSON.stringify(result)).not.toContain("cancelled-verification-key");
  });

  test("prompts for a secret, verifies before saving, and prints only a safe summary", async () => {
    const { run, store, config_path, connections, list_calls, state } =
      await fixture();
    const secret = "interactive-login-test-key";
    state.before_list = async () => {
      expect(await Bun.file(config_path).exists()).toBe(false);
    };
    const result = await run(["auth", "login", "personal", "--json"], {
      is_interactive: true,
      secret_input: secret,
    });
    expect(result.exit_code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.secret_prompts).toHaveLength(1);
    expect(result.secret_prompts[0]).toContain("API key");
    expect(result.stdin_reads).toBe(0);
    expect(connections).toEqual([
      { provider_id: "vultr", credentials: { api_key: secret } },
    ]);
    expect(list_calls).toEqual(["vultr"]);
    expect(JSON.parse(result.stdout)).toEqual({
      action: "auth.login",
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
    const list_result = await run(["auth", "list", "--json"]);
    expect(JSON.parse(list_result.stdout).data[0].credentials).toEqual({
      api_key: { source: "literal", value: "[redacted]" },
    });
    const human_list = await run(["auth", "list"]);
    expect(human_list.exit_code).toBe(0);
    for (const output of [list_result, human_list]) {
      expect(output.stdout).not.toContain(secret);
      expect(output.stderr).not.toContain(secret);
    }
  });

  test("verifies environment references while saving only the reference", async () => {
    const { run, config_path, store, connections } = await fixture();
    const result = await run(
      [
        "auth",
        "login",
        "work",
        "--credential",
        "api_key=WORK_API_KEY",
        "--json",
      ],
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
        "auth",
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
    const result = await run(["auth", "login", "work", "--json"], {
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
      run(["auth", "login", "work", "--json"], {
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
      ["auth", "login", "../invalid"],
      ["auth", "login", "a".repeat(65)],
      ["auth", "login", "work", "--provider", "other"],
      ["auth", "login", "new", "--provider", "missing"],
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
        ["auth", "login", "work", "--credentials-stdin", "--json"],
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
      const result = await run(["auth", "login", "work", ...flags, "--json"]);
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
    const result = await run(["auth", "login", "work", "--json"]);
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
    const cancelled = new AppError("cancelled", "Operation cancelled.");
    const result = await run(["auth", "login", "work", "--json"], {
      is_interactive: true,
      secret_error: cancelled,
    });
    expect(result.exit_code).toBe(130);
    expect(result.stdout).toBe("");
    expect(result.secret_prompts).toHaveLength(1);
    expect(connections).toEqual([]);
    expect(await readFile(config_path, "utf8")).toBe(original);
  });
});
