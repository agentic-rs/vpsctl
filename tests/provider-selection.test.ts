import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CliIO, runCli } from "../src/commands/program.ts";
import { AccountStore } from "../src/core/accounts.ts";
import { AppError } from "../src/core/errors.ts";
import type { ProviderDefinition } from "../src/core/provider.ts";
import { ProviderRegistry } from "../src/core/registry.ts";

interface RunOptions {
  is_interactive?: boolean;
  env?: Readonly<Record<string, string | undefined>>;
  selected_provider?: string;
  selection_error?: AppError;
  secret_input?: string;
  stdin_input?: string;
}

const temp_dirs: string[] = [];

async function fixture() {
  const temp_dir = await mkdtemp(join(tmpdir(), "vpsctl-provider-selection-"));
  temp_dirs.push(temp_dir);
  const config_path = join(temp_dir, "config.json");
  const store = new AccountStore(config_path);
  const connections: string[] = [];
  const definitions: ProviderDefinition[] = [
    {
      info: { id: "vultr", name: "Test Vultr", capabilities: [] },
      credential_fields: ["api_key"],
      create() {
        connections.push("vultr");
        throw new Error("Offline account registration must not connect.");
      },
    },
    {
      info: { id: "other", name: "Test Token Provider", capabilities: [] },
      credential_fields: ["access_token"],
      create() {
        connections.push("other");
        throw new Error("Offline account registration must not connect.");
      },
    },
  ];
  const registry = new ProviderRegistry(definitions);
  const run = async (argv: string[], options: RunOptions = {}) => {
    const output: string[] = [];
    const errors: string[] = [];
    const secret_prompts: string[] = [];
    const provider_prompts: {
      message: string;
      options: Parameters<NonNullable<CliIO["select"]>>[1];
    }[] = [];
    let stdin_reads = 0;
    const io: CliIO = {
      is_interactive: options.is_interactive ?? false,
      write_out(text) {
        output.push(text);
      },
      write_err(text) {
        errors.push(text);
      },
      async confirm() {
        throw new Error("Account registration must not request confirmation.");
      },
      async select(message, choices) {
        provider_prompts.push({ message, options: choices });
        if (options.selection_error) throw options.selection_error;
        return options.selected_provider ?? choices[0]?.value ?? "";
      },
      async read_secret(message) {
        secret_prompts.push(message);
        return options.secret_input ?? "";
      },
      async read_stdin() {
        stdin_reads += 1;
        return options.stdin_input ?? "";
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
      provider_prompts,
      stdin_reads,
    };
  };
  return { run, store, config_path, connections };
}

afterEach(async () => {
  await Promise.all(
    temp_dirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("provider selection for offline account registration", () => {
  test("chooses a provider before requesting its credential fields", async () => {
    const { run, store, connections } = await fixture();
    const secret = "selected-provider-test-token";
    const result = await run(["auth", "add", "sample"], {
      is_interactive: true,
      selected_provider: "other",
      secret_input: secret,
    });
    expect(result.exit_code).toBe(0);
    expect(result.provider_prompts).toEqual([
      {
        message: "Choose a provider",
        options: [
          { value: "vultr", label: "Test Vultr", hint: "vultr" },
          { value: "other", label: "Test Token Provider", hint: "other" },
        ],
      },
    ]);
    expect(result.secret_prompts).toEqual(["Test Token Provider access token"]);
    expect(result.stdin_reads).toBe(0);
    expect((await store.read()).accounts).toEqual([
      {
        id: "sample",
        provider_id: "other",
        credentials: { access_token: { source: "literal", value: secret } },
      },
    ]);
    expect(connections).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  test("offers the picker when credentials are environment references", async () => {
    const { run, store, config_path, connections } = await fixture();
    const secret = "environment-selection-test-token";
    const result = await run(
      ["auth", "add", "sample", "--credential", "access_token=SAMPLE_TOKEN"],
      {
        is_interactive: true,
        selected_provider: "other",
        env: { SAMPLE_TOKEN: secret },
      },
    );
    expect(result.exit_code).toBe(0);
    expect(result.provider_prompts).toHaveLength(1);
    expect(result.secret_prompts).toEqual([]);
    expect(result.stdin_reads).toBe(0);
    expect((await store.read()).accounts[0]).toEqual({
      id: "sample",
      provider_id: "other",
      credentials: { access_token: { source: "env", name: "SAMPLE_TOKEN" } },
    });
    expect(await readFile(config_path, "utf8")).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(connections).toEqual([]);
  });

  test("uses explicit and canonical providers without a redundant picker", async () => {
    const { run, store } = await fixture();
    for (const args of [
      ["sample", "--provider", "other"],
      ["other:sample@example.com"],
    ]) {
      const result = await run(["auth", "add", ...args], {
        is_interactive: true,
        selected_provider: "must-not-select-provider",
        secret_input: "inferred-provider-test-token",
      });
      expect(result.exit_code).toBe(0);
      expect(result.provider_prompts).toEqual([]);
      expect(result.secret_prompts).toEqual([
        "Test Token Provider access token",
      ]);
    }
    expect(
      (await store.read()).accounts.map(({ provider_id }) => provider_id),
    ).toEqual(["other", "other"]);
  });

  test("requires a provider for scripted aliases before reading credentials", async () => {
    const { run, config_path, connections } = await fixture();
    for (const { args, is_interactive } of [
      {
        args: ["--credential", "api_key=SAMPLE_KEY"],
        is_interactive: false,
      },
      { args: ["--credentials-stdin"], is_interactive: false },
      { args: ["--credentials-stdin"], is_interactive: true },
      {
        args: ["--credential", "api_key=SAMPLE_KEY", "--json"],
        is_interactive: true,
      },
    ]) {
      const result = await run(["auth", "add", "sample", ...args], {
        is_interactive,
        env: { SAMPLE_KEY: "scripted-provider-test-key" },
        stdin_input: JSON.stringify({ api_key: "piped-provider-test-key" }),
      });
      expect(result.exit_code).toBe(1);
      expect(result.stderr).toContain("--provider");
      expect(result.provider_prompts).toEqual([]);
      expect(result.secret_prompts).toEqual([]);
      expect(result.stdin_reads).toBe(0);
      expect(result.stdout).toBe("");
    }
    expect(await Bun.file(config_path).exists()).toBe(false);
    expect(connections).toEqual([]);
  });

  test("accepts explicit or inferred providers for stdin and JSON registration", async () => {
    const { run, store, connections } = await fixture();
    for (const args of [
      ["sample", "--provider", "other"],
      ["other:sample@example.com"],
    ]) {
      const result = await run(
        ["auth", "add", ...args, "--credentials-stdin", "--json"],
        {
          is_interactive: true,
          stdin_input: JSON.stringify({
            access_token: "piped-selection-test-token",
          }),
        },
      );
      expect(result.exit_code).toBe(0);
      expect(result.provider_prompts).toEqual([]);
      expect(result.secret_prompts).toEqual([]);
      expect(result.stdin_reads).toBe(1);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        action: "auth.add",
        data: { id: args[0], provider_id: "other" },
      });
      expect(result.stdout).not.toContain("piped-selection-test-token");
    }
    expect((await store.read()).accounts).toHaveLength(2);
    expect(connections).toEqual([]);
  });

  test("rejects mismatched and unknown providers before requesting credentials", async () => {
    const { run, config_path, connections } = await fixture();
    for (const args of [
      ["other:sample@example.com", "--provider", "vultr"],
      ["missing:sample@example.com"],
      ["sample", "--provider", "missing"],
    ]) {
      const result = await run(["auth", "add", ...args], {
        is_interactive: true,
        secret_input: "must-not-read-test-token",
      });
      expect(result.exit_code).toBe(1);
      expect(result.provider_prompts).toEqual([]);
      expect(result.secret_prompts).toEqual([]);
      expect(result.stdin_reads).toBe(0);
      expect(result.stdout).toBe("");
    }
    expect(await Bun.file(config_path).exists()).toBe(false);
    expect(connections).toEqual([]);
  });

  test("cancelling provider selection creates no configuration or secret prompt", async () => {
    const { run, config_path, connections } = await fixture();
    const result = await run(["auth", "add", "sample"], {
      is_interactive: true,
      selection_error: new AppError("cancelled", "Operation cancelled."),
    });
    expect(result.exit_code).toBe(130);
    expect(result.provider_prompts).toHaveLength(1);
    expect(result.secret_prompts).toEqual([]);
    expect(result.stdin_reads).toBe(0);
    expect(result.stdout).toBe("");
    expect(await Bun.file(config_path).exists()).toBe(false);
    expect(connections).toEqual([]);
  });
});
