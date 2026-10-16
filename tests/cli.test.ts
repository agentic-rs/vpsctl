import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CliIO, runCli } from "../src/commands/program.ts";
import { type Account, AccountStore } from "../src/core/accounts.ts";
import { AppError } from "../src/core/errors.ts";
import type {
  CreateInstanceInput,
  EditInstanceInput,
  Instance,
  Provider,
  ProviderDefinition,
} from "../src/core/provider.ts";
import { ProviderRegistry } from "../src/core/registry.ts";

interface ProviderCall {
  action: string;
  api_key: string;
  instance_id?: string;
  input?: CreateInstanceInput | EditInstanceInput;
  region_id?: string;
}

interface RunOptions {
  env?: Readonly<Record<string, string | undefined>>;
  is_interactive?: boolean;
  confirmation?: boolean;
  secret_input?: string;
  stdin_input?: string;
}

const temp_dirs: string[] = [];
const credentials = {
  VULTR_WORK_TOKEN: "work-token-value",
  VULTR_PERSONAL_TOKEN: "personal-token-value",
};

function account(id: string, name: string): Account {
  return {
    id,
    provider_id: "vultr",
    credentials: { api_key: { source: "env", name } },
  };
}

function instance(id: string): Instance {
  return {
    provider_id: "vultr",
    id,
    label: "web-server",
    region_id: "nrt",
    plan_id: "vc2-1c-1gb",
    image_id: "2284",
    status: "running",
    provider_status: "active",
    power_status: "running",
    server_status: "ok",
    public_ipv4: "192.0.2.10",
    public_ipv6: "2001:db8::10",
    tags: ["production"],
  };
}

async function fixture() {
  const temp_dir = await mkdtemp(join(tmpdir(), "vps-ctl-cli-"));
  temp_dirs.push(temp_dir);
  const config_path = join(temp_dir, "config.json");
  const store = new AccountStore(config_path);
  const calls: ProviderCall[] = [];
  const connections: Readonly<Record<string, string>>[] = [];
  const failing_keys = new Set<string>();
  const inventory_by_key = new Map<string, Instance[]>();
  const info = {
    id: "vultr",
    name: "Test provider",
    capabilities: ["instances", "catalog"],
  };
  const definition: ProviderDefinition = {
    info,
    credential_fields: ["api_key"],
    create(resolved_credentials): Provider {
      connections.push(resolved_credentials);
      const api_key = resolved_credentials.api_key ?? "";
      const instance_id =
        api_key === credentials.VULTR_WORK_TOKEN ? "work-vm" : "personal-vm";
      const record = (call: Omit<ProviderCall, "api_key">): void => {
        calls.push({ api_key, ...call });
      };
      return {
        info,
        async listInstances() {
          record({ action: "list" });
          if (failing_keys.has(api_key)) {
            throw new AppError(
              "network_error",
              "Provider temporarily unavailable.",
            );
          }
          return inventory_by_key.get(api_key) ?? [instance(instance_id)];
        },
        async getInstance(id) {
          record({ action: "get", instance_id: id });
          return instance(id);
        },
        async createInstance(input) {
          record({ action: "create", input });
          return instance("created-vm");
        },
        async editInstance(id, input) {
          record({ action: "edit", instance_id: id, input });
          return { ...instance(id), ...input };
        },
        async destroyInstance(id) {
          record({ action: "destroy", instance_id: id });
        },
        async startInstance(id) {
          record({ action: "start", instance_id: id });
        },
        async stopInstance(id) {
          record({ action: "stop", instance_id: id });
        },
        async rebootInstance(id) {
          record({ action: "reboot", instance_id: id });
        },
        async listRegions() {
          record({ action: "regions" });
          return [{ id: "nrt", name: "Tokyo", country: "JP" }];
        },
        async listPlans(region_id) {
          record({
            action: "plans",
            ...(region_id !== undefined ? { region_id } : {}),
          });
          return [
            {
              id: "vc2-1c-1gb",
              vcpu_count: 1,
              memory_mb: 1024,
              disk_gb: 25,
              monthly_cost: 5,
              currency: "USD",
              region_ids: ["nrt"],
            },
          ];
        },
        async listImages() {
          record({ action: "images" });
          return [
            {
              id: "2284",
              name: "Ubuntu 24.04",
              architecture: "x64",
              family: "ubuntu",
            },
          ];
        },
        async listSshKeys() {
          record({ action: "ssh_keys" });
          return [{ id: "key-1", name: "work" }];
        },
      };
    },
  };
  const registry = new ProviderRegistry([definition]);
  const run = async (argv: string[], options: RunOptions = {}) => {
    const output: string[] = [];
    const errors: string[] = [];
    const confirmations: string[] = [];
    const secret_prompts: string[] = [];
    let stdin_reads = 0;
    const io: CliIO = {
      write_out: (text) => output.push(text),
      write_err: (text) => errors.push(text),
      is_interactive: options.is_interactive ?? false,
      async confirm(message) {
        confirmations.push(message);
        return options.confirmation ?? false;
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
      env: options.env ?? credentials,
      io,
      registry,
    });
    return {
      exit_code,
      stdout: output.join(""),
      stderr: errors.join(""),
      confirmations,
      secret_prompts,
      stdin_reads,
    };
  };
  const addAccounts = async () => {
    await store.add(account("work", "VULTR_WORK_TOKEN"));
    await store.add(account("personal", "VULTR_PERSONAL_TOKEN"));
    await store.use("work");
  };
  return {
    config_path,
    store,
    calls,
    connections,
    failing_keys,
    inventory_by_key,
    run,
    addAccounts,
  };
}

afterEach(async () => {
  await Promise.all(
    temp_dirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("local accounts and account routing", () => {
  test("stores an interactively entered credential locally without printing it", async () => {
    const { run, store, config_path, connections } = await fixture();
    const secret = "interactive-local-token";
    const result = await run(
      ["auth", "add", "local", "--provider", "vultr", "--json"],
      { env: {}, is_interactive: true, secret_input: secret },
    );
    expect(result.exit_code).toBe(0);
    expect(result.secret_prompts).toHaveLength(1);
    expect(result.secret_prompts[0]).toContain("API key");
    expect(result.stdin_reads).toBe(0);
    expect(result.stdout).not.toContain(secret);
    expect(result.stderr).not.toContain(secret);
    expect(await store.read()).toEqual({
      version: 1,
      accounts: [
        {
          id: "local",
          provider_id: "vultr",
          credentials: { api_key: { source: "literal", value: secret } },
        },
      ],
    });
    expect(await readFile(config_path, "utf8")).toContain(secret);
    expect(connections).toEqual([]);
    await store.use("local");
    expect(
      (await run(["instance", "list", "--json"], { env: {} })).exit_code,
    ).toBe(0);
    expect(connections).toEqual([{ api_key: secret }]);
  });

  test("accepts piped credential JSON without prompting or printing secrets", async () => {
    const { run, store, connections } = await fixture();
    const secret = "piped-local-token";
    const result = await run(
      [
        "auth",
        "add",
        "automated",
        "--provider",
        "vultr",
        "--credentials-stdin",
        "--json",
      ],
      { env: {}, stdin_input: `${JSON.stringify({ api_key: secret })}\n` },
    );
    expect(result.exit_code).toBe(0);
    expect(result.stdin_reads).toBe(1);
    expect(result.secret_prompts).toEqual([]);
    expect(result.stdout).not.toContain(secret);
    expect(result.stderr).not.toContain(secret);
    expect((await store.read()).accounts).toEqual([
      {
        id: "automated",
        provider_id: "vultr",
        credentials: { api_key: { source: "literal", value: secret } },
      },
    ]);
    expect(connections).toEqual([]);
  });

  test("rejects missing or extra piped credential fields without persisting or echoing input", async () => {
    const { run, config_path, connections } = await fixture();
    const secret = "must-never-echo-invalid-input";
    for (const input of [
      {},
      { api_key: secret, extra_field: secret },
      { api_key: " " },
    ]) {
      const result = await run(
        [
          "auth",
          "add",
          "invalid",
          "--provider",
          "vultr",
          "--credentials-stdin",
          "--json",
        ],
        { env: {}, stdin_input: JSON.stringify(input) },
      );
      expect(result.exit_code).toBe(1);
      expect(JSON.parse(result.stderr)).toMatchObject({
        error: { code: "invalid_input" },
      });
      expect(result.stdout).not.toContain(secret);
      expect(result.stderr).not.toContain(secret);
      expect(result.secret_prompts).toEqual([]);
      expect(await Bun.file(config_path).exists()).toBe(false);
    }
    expect(connections).toEqual([]);
  });

  test("redacts locally stored credentials in JSON and human-readable account lists", async () => {
    const { run, store, connections } = await fixture();
    const secret = "list-must-hide-local-token";
    await store.add({
      id: "local",
      provider_id: "vultr",
      credentials: { api_key: { source: "literal", value: secret } },
    });
    await store.add(account("work", "VULTR_WORK_TOKEN"));
    await store.use("local");
    const json_result = await run(["auth", "list", "--json"], { env: {} });
    expect(json_result.exit_code).toBe(0);
    expect(JSON.parse(json_result.stdout)).toEqual({
      action: "auth.list",
      data: [
        {
          id: "local",
          provider_id: "vultr",
          is_default: true,
          credentials: {
            api_key: { source: "literal", value: "[redacted]" },
          },
        },
        { ...account("work", "VULTR_WORK_TOKEN"), is_default: false },
      ],
    });
    const human_result = await run(["auth", "list"], { env: {} });
    expect(human_result.exit_code).toBe(0);
    for (const result of [json_result, human_result]) {
      expect(result.stdout).not.toContain(secret);
      expect(result.stderr).not.toContain(secret);
    }
    expect(connections).toEqual([]);
  });

  test("registers credential references and lists accounts without resolving secrets", async () => {
    const { config_path, connections, run } = await fixture();
    for (const [id, name] of [
      ["work", "VULTR_WORK_TOKEN"],
      ["personal", "VULTR_PERSONAL_TOKEN"],
    ] as const) {
      const result = await run(
        [
          "auth",
          "add",
          id,
          "--provider",
          "vultr",
          "--credential",
          `api_key=${name}`,
        ],
        { env: {} },
      );
      expect(result.exit_code).toBe(0);
    }
    expect((await run(["auth", "use", "work"], { env: {} })).exit_code).toBe(0);
    const result = await run(["auth", "list", "--json"], { env: {} });
    expect(result.exit_code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      action: "auth.list",
      data: [
        { ...account("work", "VULTR_WORK_TOKEN"), is_default: true },
        { ...account("personal", "VULTR_PERSONAL_TOKEN"), is_default: false },
      ],
    });
    const saved = await readFile(config_path, "utf8");
    expect(saved).not.toContain(credentials.VULTR_WORK_TOKEN);
    expect(saved).not.toContain(credentials.VULTR_PERSONAL_TOKEN);
    expect(connections).toEqual([]);
  });

  test("routes default, environment-selected, and explicit accounts to their own credentials", async () => {
    const { run, addAccounts, connections, calls } = await fixture();
    await addAccounts();
    const default_result = await run(["instance", "list", "--json"]);
    const env_result = await run(["instance", "list", "--json"], {
      env: { ...credentials, VPS_CTL_ACCOUNT: "personal" },
    });
    const explicit_result = await run(
      ["instance", "list", "--account", "work", "--json"],
      { env: { ...credentials, VPS_CTL_ACCOUNT: "personal" } },
    );
    for (const result of [default_result, env_result, explicit_result]) {
      expect(result.exit_code).toBe(0);
      expect(result.stderr).toBe("");
    }
    expect(JSON.parse(default_result.stdout)).toMatchObject({
      account_id: "work",
      data: [{ id: "work-vm" }],
    });
    expect(JSON.parse(env_result.stdout)).toMatchObject({
      account_id: "personal",
      data: [{ id: "personal-vm" }],
    });
    expect(JSON.parse(explicit_result.stdout)).toMatchObject({
      account_id: "work",
      data: [{ id: "work-vm" }],
    });
    expect(connections).toEqual([
      { api_key: credentials.VULTR_WORK_TOKEN },
      { api_key: credentials.VULTR_PERSONAL_TOKEN },
      { api_key: credentials.VULTR_WORK_TOKEN },
    ]);
    expect(calls.map(({ action }) => action)).toEqual(["list", "list", "list"]);
  });

  test.each(["--all", "--all-accounts"])(
    "%s aggregates accounts and reports partial failure with exit code 1",
    async (flag) => {
      const { run, addAccounts, calls, failing_keys } = await fixture();
      await addAccounts();
      failing_keys.add(credentials.VULTR_PERSONAL_TOKEN);
      const result = await run(["instance", "list", flag, "--json"]);
      expect(result.exit_code).toBe(1);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        action: "instance.list",
        data: [
          {
            account_id: "work",
            provider_id: "vultr",
            instances: [instance("work-vm")],
          },
          {
            account_id: "personal",
            provider_id: "vultr",
            error: "Provider temporarily unavailable.",
          },
        ],
      });
      expect(calls).toEqual([
        { action: "list", api_key: credentials.VULTR_WORK_TOKEN },
        { action: "list", api_key: credentials.VULTR_PERSONAL_TOKEN },
      ]);
    },
  );

  test.each(["--all", "--all-accounts"])(
    "rejects %s combined with either account selector",
    async (flag) => {
      const { run, addAccounts, connections } = await fixture();
      await addAccounts();
      for (const result of [
        await run(["instance", "list", flag, "--account", "work"]),
        await run(["instance", "list", flag], {
          env: { ...credentials, VPS_CTL_ACCOUNT: "work" },
        }),
      ]) {
        expect(result.exit_code).toBe(1);
        expect(result.stderr).toContain(
          "cannot be combined with --account or VPS_CTL_ACCOUNT",
        );
      }
      expect(connections).toEqual([]);
    },
  );

  test("--all and --all-accounts produce the same inventory in human and JSON output", async () => {
    const { run, addAccounts } = await fixture();
    await addAccounts();
    for (const format of [[], ["--json"]]) {
      const current = await run(["instance", "list", "--all", ...format]);
      const legacy = await run([
        "instance",
        "list",
        "--all-accounts",
        ...format,
      ]);
      expect(current.exit_code).toBe(0);
      expect(current.stdout).toBe(legacy.stdout);
      expect(current.stderr).toBe("");
      expect(legacy.exit_code).toBe(0);
      expect(legacy.stderr).toBe("");
      expect(current.stdout).toContain("work-vm");
      expect(current.stdout).toContain("personal-vm");
    }
  });

  test.each(["--all", "--all-accounts"])(
    "%s handles an empty account store without connecting",
    async (flag) => {
      const { run, connections } = await fixture();
      const human = await run(["instance", "list", flag]);
      expect(human.exit_code).toBe(0);
      expect(human.stdout).toContain("No accounts configured.");
      expect(human.stderr).toBe("");
      const json = await run(["instance", "list", flag, "--json"]);
      expect(json.exit_code).toBe(0);
      expect(JSON.parse(json.stdout)).toEqual({
        action: "instance.list",
        data: [],
      });
      expect(json.stderr).toBe("");
      expect(connections).toEqual([]);
    },
  );
});

describe("instance listing costs", () => {
  test("shows provided monthly prices, including zero and prices first present on a later row", async () => {
    const { run, addAccounts, inventory_by_key } = await fixture();
    await addAccounts();
    inventory_by_key.set(credentials.VULTR_WORK_TOKEN, [
      instance("unknown-price"),
      { ...instance("priced-vm"), monthly_cost: 12.5, currency: "USD" },
      { ...instance("free-vm"), monthly_cost: 0, currency: "USD" },
    ]);
    const human = await run(["instance", "list"]);
    expect(human.exit_code).toBe(0);
    const lines = human.stdout.split("\n");
    const heading = lines.find((line) => line.includes("monthly_cost"));
    expect(heading).toContain("currency");
    const priced_row = lines.find((line) => line.startsWith("priced-vm"));
    expect(priced_row).toContain("12.5");
    expect(priced_row).toContain("USD");
    const free_row = lines.find((line) => line.startsWith("free-vm"));
    expect(free_row).toMatch(/\s0\s/);
    expect(free_row).toContain("USD");
    expect(
      lines.find((line) => line.startsWith("unknown-price")),
    ).not.toContain("USD");
    expect(human.stderr).toBe("");

    const json = await run(["instance", "list", "--json"]);
    expect(json.exit_code).toBe(0);
    const rows = JSON.parse(json.stdout).data;
    expect(rows[0]).not.toHaveProperty("monthly_cost");
    expect(rows[0]).not.toHaveProperty("currency");
    expect(rows[1]).toMatchObject({
      id: "priced-vm",
      monthly_cost: 12.5,
      currency: "USD",
    });
    expect(rows[2]).toMatchObject({
      id: "free-vm",
      monthly_cost: 0,
      currency: "USD",
    });
    expect(json.stderr).toBe("");
  });

  test("preserves per-instance costs when aggregating accounts", async () => {
    const { run, addAccounts, inventory_by_key } = await fixture();
    await addAccounts();
    inventory_by_key.set(credentials.VULTR_WORK_TOKEN, [
      { ...instance("priced-vm"), monthly_cost: 7.25, currency: "USD" },
    ]);
    inventory_by_key.set(credentials.VULTR_PERSONAL_TOKEN, [
      instance("unknown-price"),
    ]);
    const human = await run(["instance", "list", "--all"]);
    expect(human.exit_code).toBe(0);
    expect(human.stdout).toContain("monthly_cost");
    expect(human.stdout).toContain("7.25");
    expect(human.stdout).toContain("USD");
    expect(human.stderr).toBe("");

    const json = await run(["instance", "list", "--all", "--json"]);
    expect(json.exit_code).toBe(0);
    const accounts = JSON.parse(json.stdout).data;
    expect(accounts[0]).toMatchObject({
      account_id: "work",
      instances: [{ monthly_cost: 7.25, currency: "USD" }],
    });
    expect(accounts[1].instances[0]).not.toHaveProperty("monthly_cost");
    expect(accounts[1].instances[0]).not.toHaveProperty("currency");
    expect(json.stderr).toBe("");
  });

  test("does not invent a monthly price from hourly pricing", async () => {
    const { run, addAccounts, inventory_by_key } = await fixture();
    await addAccounts();
    inventory_by_key.set(credentials.VULTR_WORK_TOKEN, [
      { ...instance("hourly-vm"), hourly_cost: 0.5, currency: "USD" },
    ]);
    for (const selector of [[], ["--all"]]) {
      const human = await run(["instance", "list", ...selector]);
      expect(human.exit_code).toBe(0);
      expect(human.stdout).toContain("hourly_cost");
      expect(human.stdout).not.toContain("monthly_cost");
      const json = await run(["instance", "list", ...selector, "--json"]);
      expect(json.exit_code).toBe(0);
      expect(json.stdout).toContain('"hourly_cost": 0.5');
      expect(json.stdout).not.toContain("monthly_cost");
    }
  });
});

describe("mutation boundaries", () => {
  test("previews a create request offline without credentials or provider construction", async () => {
    const { run, addAccounts, calls, connections } = await fixture();
    await addAccounts();
    const result = await run(
      [
        "instance",
        "buy",
        "--region",
        "nrt",
        "--plan",
        "vc2-1c-1gb",
        "--image",
        "2284",
        "--enable-ipv6",
        "--dry-run",
        "--json",
      ],
      { env: {}, is_interactive: true },
    );
    expect(result.exit_code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      action: "instance.create",
      data: {
        account_id: "work",
        provider_id: "vultr",
        action: "instance.create",
        dry_run: true,
        input: {
          region_id: "nrt",
          plan_id: "vc2-1c-1gb",
          image_id: "2284",
          enable_ipv6: true,
        },
      },
    });
    expect(result.stderr).toBe("");
    expect(result.confirmations).toEqual([]);
    expect(connections).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("cancels an interactive mutation before reading credentials", async () => {
    const { run, addAccounts, calls, connections } = await fixture();
    await addAccounts();
    const result = await run(["instance", "destroy", "work-vm", "--json"], {
      env: {},
      is_interactive: true,
      confirmation: false,
    });
    expect(result.exit_code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      account_id: "work",
      action: "instance.destroy",
      data: { status: "cancelled" },
    });
    expect(JSON.parse(result.stderr)).toMatchObject({
      account_id: "work",
      action: "instance.destroy",
      instance_id: "work-vm",
    });
    expect(result.confirmations).toEqual(["Apply this change?"]);
    expect(connections).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("requires --yes for noninteractive mutations without connecting", async () => {
    const { run, addAccounts, calls, connections } = await fixture();
    await addAccounts();
    for (const action of ["start", "stop", "reboot", "destroy"]) {
      const result = await run(["instance", action, "work-vm", "--json"]);
      expect(result.exit_code).toBe(1);
      expect(JSON.parse(result.stderr)).toMatchObject({
        error: {
          code: "invalid_input",
          message: expect.stringContaining("--yes"),
        },
      });
      expect(result.stdout).toBe("");
      expect(result.confirmations).toEqual([]);
    }
    expect(connections).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("--yes sends one exact create payload with snake_case option fields", async () => {
    const { run, addAccounts, calls, connections } = await fixture();
    await addAccounts();
    const result = await run([
      "instance",
      "create",
      "--region",
      "nrt",
      "--plan",
      "vc2-1c-1gb",
      "--image",
      "2284",
      "--label",
      "frontend",
      "--hostname",
      "web.example.test",
      "--ssh-key",
      "key-1",
      "--ssh-key",
      "key-2",
      "--tag",
      "production",
      "--tag",
      "web",
      "--enable-ipv6",
      "--yes",
      "--json",
    ]);
    expect(result.exit_code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.confirmations).toEqual([]);
    expect(connections).toHaveLength(1);
    expect(calls).toEqual([
      {
        action: "create",
        api_key: credentials.VULTR_WORK_TOKEN,
        input: {
          region_id: "nrt",
          plan_id: "vc2-1c-1gb",
          image_id: "2284",
          label: "frontend",
          hostname: "web.example.test",
          ssh_key_ids: ["key-1", "key-2"],
          tags: ["production", "web"],
          enable_ipv6: true,
        },
      },
    ]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      account_id: "work",
      action: "instance.create",
      data: { id: "created-vm" },
    });
  });

  test("clears tags with an empty array and leaves omitted tags untouched", async () => {
    const { run, addAccounts, calls } = await fixture();
    await addAccounts();
    const clear_result = await run([
      "instance",
      "edit",
      "work-vm",
      "--clear-tags",
      "--yes",
    ]);
    const label_result = await run([
      "instance",
      "edit",
      "work-vm",
      "--label",
      "renamed",
      "--plan",
      "vc2-2c-2gb",
      "--yes",
    ]);
    expect(clear_result.exit_code).toBe(0);
    expect(label_result.exit_code).toBe(0);
    expect(calls).toEqual([
      {
        action: "edit",
        api_key: credentials.VULTR_WORK_TOKEN,
        instance_id: "work-vm",
        input: { tags: [] },
      },
      {
        action: "edit",
        api_key: credentials.VULTR_WORK_TOKEN,
        instance_id: "work-vm",
        input: { label: "renamed", plan_id: "vc2-2c-2gb" },
      },
    ]);
  });

  test("rejects empty edits, blank fields, malformed IDs, and conflicting tag flags", async () => {
    const { run, addAccounts, calls, connections } = await fixture();
    await addAccounts();
    const invalid_commands = [
      ["instance", "edit", "work-vm", "--yes"],
      ["instance", "edit", "work-vm", "--label", " ", "--yes"],
      ["instance", "edit", "work-vm", "--tag", "", "--yes"],
      ["instance", "edit", "../work-vm", "--label", "renamed", "--yes"],
      [
        "instance",
        "edit",
        "work-vm",
        "--tag",
        "production",
        "--clear-tags",
        "--yes",
      ],
    ];
    for (const command of invalid_commands) {
      const result = await run([...command, "--json"]);
      expect(result.exit_code).toBe(1);
      expect(JSON.parse(result.stderr)).toMatchObject({
        error: { code: "invalid_input" },
      });
      expect(result.stdout).toBe("");
    }
    expect(connections).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("CLI diagnostics and discovery", () => {
  test.each([
    {
      scope: "spec",
      resource: "region",
      action: "spec.list.region",
      provider_action: "regions",
      id: "nrt",
      args: [],
    },
    {
      scope: "spec",
      resource: "plan",
      action: "spec.list.plan",
      provider_action: "plans",
      id: "vc2-1c-1gb",
      args: ["--region", "nrt"],
    },
    {
      scope: "spec",
      resource: "image",
      action: "spec.list.image",
      provider_action: "images",
      id: "2284",
      args: [],
    },
    {
      scope: "credential",
      resource: "ssh-key",
      action: "credential.list.ssh_key",
      provider_action: "ssh_keys",
      id: "key-1",
      args: [],
    },
  ])(
    "routes $scope list $resource to the selected provider with a scoped JSON action",
    async ({ scope, resource, action, provider_action, id, args }) => {
      const { run, addAccounts, calls } = await fixture();
      await addAccounts();
      const result = await run([scope, "list", resource, ...args, "--json"]);
      expect(result.exit_code).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        account_id: "work",
        provider_id: "vultr",
        action,
        data: [{ id }],
      });
      expect(calls).toEqual([
        {
          action: provider_action,
          api_key: credentials.VULTR_WORK_TOKEN,
          ...(resource === "plan" ? { region_id: "nrt" } : {}),
        },
      ]);
    },
  );

  test("rejects unknown specifications and incompatible filters before account selection", async () => {
    const { run, config_path, connections, calls } = await fixture();
    // Configuration reads would fail, proving validation precedes selection.
    await mkdir(config_path);
    const invalid_inputs = [
      ["regions"],
      ["ssh-key"],
      ...["region", "plan", "image"].flatMap((resource) =>
        [
          ["--gpu", "Example GPU"],
          ["--gpu-count", "2"],
          ["--disk-gb", "40"],
          ["--limit", "2"],
        ].map((flags) => [resource, ...flags]),
      ),
      ...["region", "image", "offer"].map((resource) => [
        resource,
        "--region",
        "nrt",
      ]),
    ];
    for (const args of invalid_inputs) {
      const result = await run(["spec", "list", ...args, "--json"], {
        env: {},
        is_interactive: true,
      });
      expect(result.exit_code).toBe(1);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr)).toMatchObject({
        error: { code: "invalid_input", message: expect.any(String) },
      });
      expect(result.secret_prompts).toEqual([]);
      expect(result.confirmations).toEqual([]);
      expect(result.stdin_reads).toBe(0);
    }
    expect(connections).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("reports missing credentials without exposing other account secrets", async () => {
    const { run, addAccounts, connections } = await fixture();
    await addAccounts();
    const result = await run(["instance", "list", "--json"], {
      env: { VULTR_PERSONAL_TOKEN: credentials.VULTR_PERSONAL_TOKEN },
    });
    expect(result.exit_code).toBe(1);
    expect(JSON.parse(result.stderr)).toEqual({
      error: {
        code: "authentication",
        message: "Missing credential environment variable: VULTR_WORK_TOKEN.",
      },
    });
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain(credentials.VULTR_PERSONAL_TOKEN);
    expect(connections).toEqual([]);
  });

  test("rejects unknown flags and missing required options as JSON errors", async () => {
    const { run, connections } = await fixture();
    for (const command of [
      ["instance", "list", "--accout", "work"],
      ["instance", "create", "--region", "nrt", "--yes"],
      ["instance", "unknown"],
    ]) {
      const result = await run([...command, "--json"], { env: {} });
      expect(result.exit_code).toBe(1);
      expect(JSON.parse(result.stderr)).toMatchObject({
        error: { code: "invalid_input", message: expect.any(String) },
      });
      expect(result.stdout).toBe("");
    }
    expect(connections).toEqual([]);
  });

  test("shows help and provider discovery with no account or credentials", async () => {
    const { config_path, run, connections } = await fixture();
    for (const command of [["--help"], ["instance", "create", "--help"]]) {
      const result = await run(command, { env: {} });
      expect(result.exit_code).toBe(0);
      expect(result.stdout).toContain("Usage:");
      expect(result.stderr).toBe("");
    }
    const result = await run(["provider", "list", "--json"], { env: {} });
    expect(result.exit_code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      action: "provider.list",
      data: [{ id: "vultr", credential_fields: ["api_key"] }],
    });
    expect(await Bun.file(config_path).exists()).toBe(false);
    expect(connections).toEqual([]);
  });
});
