import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  PromptOption,
  PromptSelectOptions,
} from "../src/commands/context.ts";
import { type CliIO, runCli } from "../src/commands/program.ts";
import { AccountStore } from "../src/core/accounts.ts";
import type { CtlClient, CtlHost } from "../src/core/ctl.ts";
import { AppError } from "../src/core/errors.ts";
import {
  InstanceCredentialStore,
  instanceCredentialPath,
} from "../src/core/instance-credentials.ts";
import type {
  Instance,
  InstanceLoginCredential,
  Provider,
  ProviderDefinition,
} from "../src/core/provider.ts";
import { ProviderRegistry } from "../src/core/registry.ts";

type HostInput = Parameters<CtlClient["createHost"]>[0];
type ProviderId = "vultr" | "runpod" | "vast";

interface CtlCall {
  action: "list" | "create" | "update" | "connect";
  host_id?: string;
  method_id?: string;
  input?: HostInput;
  authentication?: {
    user: string;
    host: string;
    port: number;
    password: string;
  };
}

interface RunOptions {
  interactive?: boolean;
  selections?: Record<string, string>;
  cancel_prompt?: string;
  username?: string;
  password?: string;
}

const temp_dirs: string[] = [];
const account_id = "sample-primary";
const second_account_id = "sample-secondary";
const synthetic_secret = "synthetic-provider-api-key";
const synthetic_password = "synthetic-instance-password";

function instance(overrides: Partial<Instance> = {}): Instance {
  return {
    provider_id: "vultr",
    id: "instance-example",
    label: "example-machine",
    region_id: "example-region",
    plan_id: "example-plan",
    image_id: "example-image",
    status: "running",
    provider_status: "active",
    power_status: "running",
    server_status: "ready",
    public_ipv4: "192.0.2.10",
    public_ipv6: "2001:db8::10",
    ssh_user: "root",
    tags: [],
    ...overrides,
  };
}

function managedName(
  provider_id = "vultr",
  selected_account = account_id,
  id = "instance-example",
): string {
  return `vpsctl-${createHash("sha256")
    .update(JSON.stringify([provider_id, selected_account, id]))
    .digest("hex")
    .slice(0, 32)}`;
}

function savedMethod(): CtlHost["connection_methods"][number] {
  return {
    method_id: "method-example",
    name: "vpsctl",
    target: {
      kind: "ssh",
      destination: "192.0.2.9",
      port: 22,
      user: "root",
    },
  };
}

function savedHost(overrides: Partial<CtlHost> = {}): CtlHost {
  return {
    host_id: "host-example",
    name: managedName(),
    connection_methods: [savedMethod()],
    preferred_method_id: "method-example",
    ...overrides,
  };
}

async function fixture(
  provider_id: ProviderId = "vultr",
  default_account = true,
) {
  const temp_dir = await mkdtemp(join(tmpdir(), "vpsctl-instance-login-"));
  temp_dirs.push(temp_dir);
  const config_path = join(temp_dir, "config.json");
  const credential_path = instanceCredentialPath(config_path);
  const credential_store = new InstanceCredentialStore(credential_path);
  const store = new AccountStore(config_path);
  for (const id of [account_id, second_account_id]) {
    await store.add({
      id,
      provider_id,
      credentials: { api_key: { source: "literal", value: synthetic_secret } },
    });
  }
  if (default_account) await store.use(account_id);

  const provider_calls: string[] = [];
  const trace: string[] = [];
  const ctl_calls: CtlCall[] = [];
  const inventory = [instance({ provider_id })];
  let fresh = instance({ provider_id });
  const hosts: CtlHost[] = [];
  const fail = new Map<string, Error>();
  let connection_exit_code = 0;
  let supports_login_credential = false;
  let login_credential: InstanceLoginCredential | undefined;
  const info = {
    id: provider_id,
    name: "Example provider",
    capabilities: ["instances"],
    instance_password_help: {
      url: "https://console.vultr.com/",
      instructions:
        "Open Compute, select this instance, then Overview → View Root Password.",
    },
  };
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected provider mutation.");
  };
  const definition: ProviderDefinition = {
    info,
    credential_fields: ["api_key"],
    create(): Provider {
      provider_calls.push("connect");
      return {
        info,
        async listInstances() {
          provider_calls.push("list");
          trace.push("provider:list");
          if (fail.has("inventory")) throw fail.get("inventory");
          return inventory;
        },
        async getInstance(id) {
          provider_calls.push(`get:${id}`);
          trace.push("provider:get");
          if (fail.has("get")) throw fail.get("get");
          return fresh;
        },
        ...(supports_login_credential
          ? {
              async getInstanceLoginCredential(id: string) {
                provider_calls.push(`credential:${id}`);
                trace.push("provider:credential");
                if (fail.has("credential")) throw fail.get("credential");
                return login_credential;
              },
            }
          : {}),
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
  const ctl: CtlClient = {
    async listHosts() {
      ctl_calls.push({ action: "list" });
      trace.push("ctl:list");
      if (fail.has("list")) throw fail.get("list");
      return hosts;
    },
    async createHost(input) {
      ctl_calls.push({ action: "create", input });
      trace.push("ctl:create");
      if (fail.has("create")) throw fail.get("create");
      const host = savedHost({
        host_id: `host-created-${hosts.length + 1}`,
        name: input.name,
        connection_methods: [
          {
            method_id: "method-created",
            name: "vpsctl",
            target: {
              kind: "ssh",
              destination: input.destination,
              port: input.port,
              ...(input.user !== undefined ? { user: input.user } : {}),
              ...(input.identity_file !== undefined
                ? { identity_file: input.identity_file }
                : {}),
            },
          },
        ],
        preferred_method_id: "method-created",
      });
      hosts.push(host);
      return host;
    },
    async updateHost(host_id, method_id, input) {
      ctl_calls.push({ action: "update", host_id, method_id, input });
      trace.push("ctl:update");
      if (fail.has("update")) throw fail.get("update");
      const position = hosts.findIndex((host) => host.host_id === host_id);
      const original = hosts[position];
      if (!original) throw new Error("Unexpected host update.");
      const host = {
        ...original,
        name: input.name,
        connection_methods: original.connection_methods.map((method) =>
          method.method_id !== method_id
            ? method
            : {
                ...method,
                target: {
                  ...method.target,
                  destination: input.destination,
                  port: input.port,
                  ...(input.user !== undefined ? { user: input.user } : {}),
                  ...(input.identity_file !== undefined
                    ? { identity_file: input.identity_file }
                    : {}),
                },
              },
        ),
      };
      hosts[position] = host;
      return host;
    },
    async connect(host_id, method_id, authentication) {
      ctl_calls.push({
        action: "connect",
        host_id,
        method_id,
        ...(authentication === undefined ? {} : { authentication }),
      });
      trace.push("ctl:connect");
      if (fail.has("connect")) throw fail.get("connect");
      return connection_exit_code;
    },
  };
  const registry = new ProviderRegistry([definition]);
  const run = async (args: string[] = [], options: RunOptions = {}) => {
    const output: string[] = [];
    const errors: string[] = [];
    const text_prompts: string[] = [];
    const secret_prompts: string[] = [];
    const prompts: {
      message: string;
      options: PromptOption[];
      prompt_options?: PromptSelectOptions;
    }[] = [];
    const io: CliIO = {
      is_interactive: options.interactive ?? false,
      write_out: (text) => output.push(text),
      write_err: (text) => errors.push(text),
      async confirm() {
        throw new Error("Unexpected confirmation prompt.");
      },
      async read_secret(message) {
        secret_prompts.push(message);
        if (message === options.cancel_prompt)
          throw new AppError("cancelled", "Operation cancelled.");
        if (options.password === undefined)
          throw new Error("Unexpected instance password prompt.");
        return options.password;
      },
      async read_text(message) {
        text_prompts.push(message);
        if (message === options.cancel_prompt)
          throw new AppError("cancelled", "Operation cancelled.");
        return options.username ?? "root";
      },
      async select(message, choices, prompt_options) {
        prompts.push({
          message,
          options: choices,
          ...(prompt_options ? { prompt_options } : {}),
        });
        if (message === options.cancel_prompt)
          throw new AppError("cancelled", "Operation cancelled.");
        const value = options.selections?.[message] ?? choices[0]?.value;
        if (value === undefined) throw new Error("Unexpected empty picker.");
        return value;
      },
    };
    const exit_code = await runCli(
      ["--config", config_path, "instance", "login", ...args],
      { env: {}, io, registry, ctl },
    );
    return {
      exit_code,
      stdout: output.join(""),
      stderr: errors.join(""),
      prompts,
      text_prompts,
      secret_prompts,
    };
  };
  return {
    run,
    store,
    config_path,
    credential_path,
    credential_store,
    inventory,
    hosts,
    ctl,
    ctl_calls,
    provider_calls,
    trace,
    fail,
    setFresh(value: Instance) {
      fresh = value;
    },
    setConnectionExitCode(value: number) {
      connection_exit_code = value;
    },
    setLoginCredential(value: InstanceLoginCredential | undefined) {
      supports_login_credential = true;
      login_credential = value;
    },
  };
}

afterEach(async () => {
  await Promise.all(
    temp_dirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("instance login through ctl", () => {
  const credential_key = {
    provider_id: "vultr",
    account_id,
    instance_id: "instance-example",
  };

  test("saves a retrieved API password for future logins without another credential request", async () => {
    const f = await fixture();
    f.setLoginCredential({ user: "root", password: synthetic_password });
    expect((await f.run(["instance-example"])).exit_code).toBe(0);
    expect(await f.credential_store.get(credential_key)).toEqual({
      user: "root",
      password: synthetic_password,
    });
    f.provider_calls.splice(0);
    f.fail.set("credential", new Error("Unexpected API password request."));

    const result = await f.run(["instance-example"]);

    expect(result.exit_code).toBe(0);
    expect(f.provider_calls).not.toContain("credential:instance-example");
    expect(result.secret_prompts).toEqual([]);
    expect(f.ctl_calls.at(-1)?.authentication?.password).toBe(
      synthetic_password,
    );
    expect(result.stdout + result.stderr).not.toContain(synthetic_password);
  });

  test("shows website instructions, saves masked input, and reuses it on the next login", async () => {
    const f = await fixture();
    f.setLoginCredential(undefined);
    const password = "  synthetic $'\\\" 密碼  ";

    const result = await f.run(["instance-example"], {
      interactive: true,
      password,
    });

    expect(result.exit_code).toBe(0);
    expect(result.stderr).toContain("https://console.vultr.com/");
    expect(result.stderr).toContain("View Root Password");
    expect(result.secret_prompts).toEqual([
      "Instance password for root (saved locally)",
    ]);
    expect(await f.credential_store.get(credential_key)).toEqual({
      user: "root",
      password,
    });
    expect(f.ctl_calls.at(-1)?.authentication?.password).toBe(password);
    expect(
      result.stdout + result.stderr + JSON.stringify(f.hosts),
    ).not.toContain(password);

    f.provider_calls.splice(0);
    const next = await f.run(["instance-example"]);
    expect(next.exit_code).toBe(0);
    expect(next.secret_prompts).toEqual([]);
    expect(f.provider_calls).not.toContain("credential:instance-example");
  });

  test("does not retain a cancelled password prompt or create a ctl host", async () => {
    const f = await fixture();
    f.setLoginCredential(undefined);
    const result = await f.run(["instance-example"], {
      interactive: true,
      cancel_prompt: "Instance password for root (saved locally)",
    });
    expect(result.exit_code).toBe(130);
    expect(await f.credential_store.get(credential_key)).toBeUndefined();
    expect(f.ctl_calls).toEqual([{ action: "list" }]);
  });

  test("refreshes a saved password through masked input without another API retrieval", async () => {
    const f = await fixture();
    f.setLoginCredential(undefined);
    await f.credential_store.set(credential_key, {
      user: "root",
      password: "synthetic-old-password",
    });

    const result = await f.run(["instance-example", "--refresh-password"], {
      interactive: true,
      password: synthetic_password,
    });

    expect(result.exit_code).toBe(0);
    expect(f.provider_calls).not.toContain("credential:instance-example");
    expect(await f.credential_store.get(credential_key)).toEqual({
      user: "root",
      password: synthetic_password,
    });
    expect(f.ctl_calls.at(-1)?.authentication?.password).toBe(
      synthetic_password,
    );
  });

  test("preserves the previous password when refreshing is cancelled", async () => {
    const f = await fixture();
    f.setLoginCredential(undefined);
    const previous = { user: "root", password: "synthetic-previous-password" };
    await f.credential_store.set(credential_key, previous);
    const result = await f.run(["instance-example", "--refresh-password"], {
      interactive: true,
      cancel_prompt: "Instance password for root (saved locally)",
    });
    expect(result.exit_code).toBe(130);
    expect(await f.credential_store.get(credential_key)).toEqual(previous);
    expect(f.provider_calls).not.toContain("credential:instance-example");
    expect(f.ctl_calls).toEqual([{ action: "list" }]);
  });

  test("rejects invalid masked input without saving or exposing it", async () => {
    const f = await fixture();
    f.setLoginCredential(undefined);
    const password = `${synthetic_password}\nextra`;
    const result = await f.run(["instance-example"], {
      interactive: true,
      password,
    });
    expect(result.exit_code).toBe(1);
    expect(result.stderr).toContain("Enter a nonempty instance password");
    expect(result.stdout + result.stderr).not.toContain(synthetic_password);
    expect(await f.credential_store.get(credential_key)).toBeUndefined();
    expect(f.ctl_calls).toEqual([{ action: "list" }]);
  });

  test("rejects noninteractive or ctl-managed password refresh before remote calls", async () => {
    for (const args of [
      ["--refresh-password"],
      ["--refresh-password", "--auth", "ctl"],
    ]) {
      const f = await fixture();
      const result = await f.run(["instance-example", ...args]);
      expect(result.exit_code).toBe(1);
      expect(result.secret_prompts).toEqual([]);
      expect(f.provider_calls).toEqual([]);
      expect(f.ctl_calls).toEqual([]);
    }
  });

  test("dry-run and explicit ctl authentication skip the password store and prompts", async () => {
    const f = await fixture();
    f.setLoginCredential(undefined);
    await Bun.write(f.credential_path, "malformed local credentials");
    for (const args of [
      ["--dry-run", "--refresh-password"],
      ["--dry-run", "--json"],
      ["--auth", "ctl"],
    ]) {
      const result = await f.run(["instance-example", ...args]);
      expect(result.exit_code).toBe(0);
      expect(result.secret_prompts).toEqual([]);
      expect(f.provider_calls).not.toContain("credential:instance-example");
    }
    expect(await Bun.file(f.credential_path).text()).toBe(
      "malformed local credentials",
    );
  });

  test("allows an explicit username when the API returned a password without user metadata", async () => {
    const f = await fixture();
    const fresh = instance();
    delete fresh.ssh_user;
    f.setFresh(fresh);
    f.setLoginCredential({ password: synthetic_password });
    const result = await f.run(["instance-example", "--user", "linuxuser"]);
    expect(result.exit_code).toBe(0);
    expect(result.secret_prompts).toEqual([]);
    expect(await f.credential_store.get(credential_key)).toEqual({
      user: "linuxuser",
      password: synthetic_password,
    });
    expect(f.ctl_calls.at(-1)?.authentication?.user).toBe("linuxuser");
  });

  test("keeps saved credentials isolated between accounts", async () => {
    const f = await fixture();
    f.setLoginCredential(undefined);
    await f.credential_store.set(credential_key, {
      user: "root",
      password: synthetic_password,
    });
    const result = await f.run([
      "instance-example",
      "--account",
      second_account_id,
    ]);
    expect(result.exit_code).toBe(1);
    expect(f.ctl_calls).toEqual([{ action: "list" }]);
    expect(result.stdout + result.stderr).not.toContain(synthetic_password);
  });

  test("creates a managed host from fresh provider details before connecting", async () => {
    const f = await fixture();
    f.setFresh(instance({ public_ipv4: "192.0.2.20" }));
    const result = await f.run(["instance-example"]);
    expect(result.exit_code).toBe(0);
    expect(f.ctl_calls).toEqual([
      { action: "list" },
      {
        action: "create",
        input: {
          name: managedName(),
          destination: "192.0.2.20",
          port: 22,
          user: "root",
        },
      },
      {
        action: "connect",
        host_id: "host-created-1",
        method_id: "method-created",
      },
    ]);
    expect(f.trace.indexOf("provider:get")).toBeLessThan(
      f.trace.indexOf("ctl:create"),
    );
    expect(f.provider_calls.filter((call) => call.startsWith("get:"))).toEqual([
      "get:instance-example",
    ]);
    expect(result.prompts).toEqual([]);
    expect(
      JSON.stringify(f.ctl_calls) + result.stdout + result.stderr,
    ).not.toContain(synthetic_secret);
  });

  test("reuses the saved host after address and label changes", async () => {
    const f = await fixture();
    f.hosts.push(savedHost());
    f.setFresh(
      instance({ label: "renamed-example", public_ipv4: "192.0.2.30" }),
    );
    const result = await f.run(["instance-example"]);
    expect(result.exit_code).toBe(0);
    expect(f.ctl_calls).toEqual([
      { action: "list" },
      {
        action: "update",
        host_id: "host-example",
        method_id: "method-example",
        input: {
          name: managedName(),
          destination: "192.0.2.30",
          port: 22,
          user: "root",
        },
      },
      {
        action: "connect",
        host_id: "host-example",
        method_id: "method-example",
      },
    ]);
    expect(f.hosts).toHaveLength(1);
  });

  test("creates once and refreshes the generated host on subsequent logins", async () => {
    const f = await fixture();
    expect((await f.run(["instance-example"])).exit_code).toBe(0);
    f.setFresh(
      instance({ public_ipv4: "192.0.2.50", label: "renamed-example" }),
    );
    expect((await f.run(["instance-example"])).exit_code).toBe(0);
    expect(f.hosts).toHaveLength(1);
    expect(f.ctl_calls.filter((call) => call.action === "create")).toHaveLength(
      1,
    );
    expect(f.ctl_calls.filter((call) => call.action === "update")).toHaveLength(
      1,
    );
    expect(
      f.ctl_calls.filter((call) => call.action === "connect"),
    ).toHaveLength(2);
    expect(f.hosts[0]?.connection_methods[0]?.target.destination).toBe(
      "192.0.2.50",
    );
  });

  test("isolates matching instance IDs in different accounts", async () => {
    const f = await fixture();
    const first = await f.run(["instance-example"]);
    const second = await f.run([
      "instance-example",
      "--account",
      second_account_id,
    ]);
    expect(first.exit_code).toBe(0);
    expect(second.exit_code).toBe(0);
    expect(
      f.ctl_calls
        .filter((call) => call.action === "create")
        .map((call) => call.input?.name),
    ).toEqual([managedName(), managedName("vultr", second_account_id)]);
    expect(f.hosts).toHaveLength(2);
  });

  test("selects a unique exact label but gives an exact ID precedence", async () => {
    const f = await fixture();
    f.inventory.push(
      instance({ id: "different-instance", label: "instance-example" }),
    );
    expect((await f.run(["instance-example"])).exit_code).toBe(0);
    expect(f.provider_calls).toContain("get:instance-example");
    const other = await fixture();
    expect((await other.run(["example-machine"])).exit_code).toBe(0);
    expect(other.provider_calls).toContain("get:instance-example");
  });

  test("offers searchable instance selection when no target is given", async () => {
    const f = await fixture();
    const result = await f.run([], { interactive: true });
    expect(result.exit_code).toBe(0);
    expect(result.prompts).toHaveLength(1);
    expect(result.prompts[0]?.options.map((option) => option.value)).toEqual([
      "instance-example",
    ]);
    expect(result.prompts[0]?.prompt_options?.searchable).toBe(true);
    expect(f.ctl_calls.at(-1)?.action).toBe("connect");
  });

  test("limits the picker to running instances and sanitizes provider text", async () => {
    const f = await fixture();
    f.inventory[0] = instance({
      label: "example\u001b[31m-machine",
      region_id: "region\nexample",
    });
    f.inventory.push(instance({ id: "stopped-example", status: "stopped" }));
    const result = await f.run([], { interactive: true });
    expect(result.exit_code).toBe(0);
    expect(result.prompts[0]?.options.map((option) => option.value)).toEqual([
      "instance-example",
    ]);
    expect(result.prompts[0]?.options[0]?.label).not.toContain("\u001b");
    expect(result.prompts[0]?.options[0]?.hint).not.toContain("\n");
  });

  test("selects an account before an instance when no default exists", async () => {
    const f = await fixture("vultr", false);
    const result = await f.run([], {
      interactive: true,
      selections: { "Choose an account": second_account_id },
    });
    expect(result.exit_code).toBe(0);
    expect(result.prompts[0]?.message).toBe("Choose an account");
    expect(
      f.ctl_calls.find((call) => call.action === "create")?.input?.name,
    ).toBe(managedName("vultr", second_account_id));
  });

  test("cancels selection without synchronizing or connecting", async () => {
    const f = await fixture("vultr", false);
    const result = await f.run([], {
      interactive: true,
      cancel_prompt: "Choose an account",
    });
    expect(result.exit_code).toBe(130);
    expect(f.provider_calls).toEqual([]);
    expect(f.ctl_calls).toEqual([]);
  });

  test("cancels instance or username selection without saving a host", async () => {
    for (const prompt of ["Choose an instance", "SSH username"]) {
      const f = await fixture();
      const fresh = instance();
      delete fresh.ssh_user;
      f.setFresh(fresh);
      const result = await f.run(
        prompt === "SSH username" ? ["instance-example"] : [],
        { interactive: true, cancel_prompt: prompt },
      );
      expect(result.exit_code).toBe(130);
      expect(f.ctl_calls.some((call) => call.action !== "list")).toBe(false);
    }
  });

  test("requires a target in noninteractive mode", async () => {
    const f = await fixture();
    const result = await f.run();
    expect(result.exit_code).toBe(1);
    expect(result.prompts).toEqual([]);
    expect(f.ctl_calls).toEqual([]);
  });

  test("rejects missing and ambiguous labels before requesting fresh details", async () => {
    for (const ambiguous of [false, true]) {
      const f = await fixture();
      if (ambiguous) f.inventory.push(instance({ id: "second-instance" }));
      const result = await f.run([
        ambiguous ? "example-machine" : "absent-instance",
      ]);
      expect(result.exit_code).toBe(1);
      expect(f.provider_calls.some((call) => call.startsWith("get:"))).toBe(
        false,
      );
      expect(f.ctl_calls).toEqual([]);
    }
  });

  test("rejects empty inventories without presenting an empty picker", async () => {
    const f = await fixture();
    f.inventory.splice(0);
    const result = await f.run([], { interactive: true });
    expect(result.exit_code).toBe(1);
    expect(result.prompts).toEqual([]);
    expect(f.ctl_calls).toEqual([]);
  });

  test("rejects a fresh response for another provider or instance", async () => {
    for (const fresh of [
      instance({ provider_id: "runpod" }),
      instance({ id: "other-instance" }),
    ]) {
      const f = await fixture();
      f.setFresh(fresh);
      const result = await f.run(["instance-example"]);
      expect(result.exit_code).toBe(1);
      expect(f.ctl_calls.some((call) => call.action !== "list")).toBe(false);
    }
  });

  test("rejects duplicate IDs or a different provider in inventory", async () => {
    for (const extra of [
      instance(),
      instance({ id: "other-instance", provider_id: "runpod" }),
    ]) {
      const f = await fixture();
      f.inventory.push(extra);
      const result = await f.run(["instance-example"]);
      expect(result.exit_code).toBe(1);
      expect(f.provider_calls.some((call) => call.startsWith("get:"))).toBe(
        false,
      );
      expect(f.ctl_calls).toEqual([]);
    }
  });

  test("rejects ambiguous saved host names without modifying either host", async () => {
    const f = await fixture();
    f.hosts.push(savedHost(), savedHost({ host_id: "host-duplicate" }));
    const result = await f.run(["instance-example"]);
    expect(result.exit_code).toBe(1);
    expect(f.ctl_calls).toEqual([{ action: "list" }]);
  });

  test("rejects missing or ambiguous managed connection methods", async () => {
    for (const methods of [
      [],
      [
        ...savedHost().connection_methods,
        {
          ...savedMethod(),
          method_id: "method-duplicate",
        },
      ],
    ]) {
      const f = await fixture();
      f.hosts.push(savedHost({ connection_methods: methods }));
      const result = await f.run(["instance-example"]);
      expect(result.exit_code).toBe(1);
      expect(f.ctl_calls).toEqual([{ action: "list" }]);
    }
  });

  test("updates only the managed method and connects it even when another method is preferred", async () => {
    const f = await fixture();
    const existing = savedHost();
    existing.connection_methods.push({
      method_id: "method-manual",
      name: "manual",
      target: {
        kind: "ssh",
        destination: "192.0.2.40",
        user: "operator",
        port: 2222,
      },
    });
    existing.preferred_method_id = "method-manual";
    f.hosts.push(existing);
    expect((await f.run(["instance-example"])).exit_code).toBe(0);
    expect(
      f.ctl_calls.find((call) => call.action === "update")?.method_id,
    ).toBe("method-example");
    expect(f.ctl_calls.at(-1)).toEqual({
      action: "connect",
      host_id: "host-example",
      method_id: "method-example",
    });
    expect(f.hosts[0]?.connection_methods[1]).toEqual(
      existing.connection_methods[1],
    );
  });

  test("rejects saved routing overrides that could bypass the fresh provider address", async () => {
    for (const override of [
      "hostname",
      "ssh_config_alias",
      "tailscale_node_id",
    ] as const) {
      const f = await fixture();
      const method = savedMethod();
      if (override === "hostname")
        method.target.hostname = "other.example.invalid";
      else method[override] = "other-example-route";
      f.hosts.push(savedHost({ connection_methods: [method] }));
      const result = await f.run(["instance-example"]);
      expect(result.exit_code).toBe(1);
      expect(f.ctl_calls).toEqual([{ action: "list" }]);
    }
  });

  test("preserves a saved username and identity when no override is supplied", async () => {
    const f = await fixture();
    const fresh = instance();
    delete fresh.ssh_user;
    f.setFresh(fresh);
    const existing = savedHost();
    const method = existing.connection_methods[0];
    if (!method) throw new Error("Missing synthetic connection method.");
    method.target.user = "operator";
    method.target.identity_file = "/example/ssh/id-test";
    f.hosts.push(existing);
    const result = await f.run(["instance-example"]);
    expect(result.exit_code).toBe(0);
    const update = f.ctl_calls.find((call) => call.action === "update");
    expect(update?.input?.user).toBe("operator");
    expect(update?.input?.identity_file).toBeUndefined();
    expect(f.hosts[0]?.connection_methods[0]?.target.identity_file).toBe(
      "/example/ssh/id-test",
    );
  });

  test("preserves a custom Vultr SSH port when the API only supplies an IP address", async () => {
    const f = await fixture();
    const method = savedMethod();
    method.target.port = 2200;
    f.hosts.push(savedHost({ connection_methods: [method] }));
    const result = await f.run(["instance-example"]);
    expect(result.exit_code).toBe(0);
    expect(
      f.ctl_calls.find((call) => call.action === "update")?.input?.port,
    ).toBe(2200);
    expect(f.ctl_calls.at(-1)?.action).toBe("connect");
  });

  test("refreshes a saved GPU SSH port from the provider's published endpoint", async () => {
    for (const provider_id of ["runpod", "vast"] as const) {
      const f = await fixture(provider_id);
      const method = savedMethod();
      method.target.port = 2200;
      f.hosts.push(
        savedHost({
          name: managedName(provider_id),
          connection_methods: [method],
        }),
      );
      f.setFresh(
        instance({
          provider_id,
          ssh_host: "ssh.example.invalid",
          ssh_port: 31234,
        }),
      );
      const result = await f.run(["instance-example"]);
      expect(result.exit_code).toBe(0);
      expect(
        f.ctl_calls.find((call) => call.action === "update")?.input?.port,
      ).toBe(31234);
      expect(f.ctl_calls.at(-1)?.action).toBe("connect");
    }
  });

  test("applies explicit username, port, and identity overrides", async () => {
    const f = await fixture();
    f.hosts.push(savedHost());
    const result = await f.run([
      "instance-example",
      "--user",
      "operator",
      "--port",
      "2200",
      "--identity-file",
      "/example/ssh/id-test",
    ]);
    expect(result.exit_code).toBe(0);
    expect(f.ctl_calls.find((call) => call.action === "update")?.input).toEqual(
      {
        name: managedName(),
        destination: "192.0.2.10",
        user: "operator",
        port: 2200,
        identity_file: "/example/ssh/id-test",
      },
    );
  });

  test("normalizes a relative identity reference before saving it to ctl", async () => {
    const f = await fixture();
    const result = await f.run([
      "instance-example",
      "--identity-file",
      "example-key",
    ]);
    expect(result.exit_code).toBe(0);
    expect(
      f.ctl_calls.find((call) => call.action === "create")?.input
        ?.identity_file,
    ).toBe(join(process.cwd(), "example-key"));
  });

  test("prompts for an unknown SSH username instead of assuming root", async () => {
    const f = await fixture();
    const fresh = instance();
    delete fresh.ssh_user;
    f.setFresh(fresh);
    const result = await f.run(["instance-example"], {
      interactive: true,
      username: "operator",
    });
    expect(result.exit_code).toBe(0);
    expect(result.text_prompts).toEqual(["SSH username"]);
    expect(
      f.ctl_calls.find((call) => call.action === "create")?.input?.user,
    ).toBe("operator");
  });

  test("requires an explicit or saved username in noninteractive mode when the provider cannot supply one", async () => {
    const f = await fixture();
    const fresh = instance();
    delete fresh.ssh_user;
    f.setFresh(fresh);
    const result = await f.run(["instance-example"]);
    expect(result.exit_code).toBe(1);
    expect(result.text_prompts).toEqual([]);
    expect(f.ctl_calls.some((call) => call.action !== "list")).toBe(false);
  });

  test("retains the provider's RunPod proxy username over a saved generic user", async () => {
    const f = await fixture("runpod");
    f.hosts.push(savedHost({ name: managedName("runpod") }));
    f.setFresh(
      instance({
        provider_id: "runpod",
        ssh_host: "ssh.runpod.example.invalid",
        ssh_port: 22,
        ssh_method: "proxy",
        ssh_user: "example-pod-route",
      }),
    );
    const result = await f.run(["instance-example"]);
    expect(result.exit_code).toBe(0);
    expect(
      f.ctl_calls.find((call) => call.action === "update")?.input,
    ).toMatchObject({
      destination: "ssh.runpod.example.invalid",
      port: 22,
      user: "example-pod-route",
    });
  });

  test("does not start stopped instances during login", async () => {
    const f = await fixture();
    f.setFresh(instance({ status: "stopped" }));
    expect((await f.run(["instance-example"])).exit_code).toBe(1);
    expect(f.ctl_calls.some((call) => call.action !== "list")).toBe(false);
  });

  test("can use IPv6 when a Vultr instance has no IPv4 address", async () => {
    const f = await fixture();
    f.setFresh(instance({ public_ipv4: "" }));
    expect((await f.run(["instance-example"])).exit_code).toBe(0);
    expect(
      f.ctl_calls.find((call) => call.action === "create")?.input?.destination,
    ).toBe("2001:db8::10");
  });

  test("uses provider-specific SSH endpoint and mapped port", async () => {
    const f = await fixture("vast");
    f.setFresh(
      instance({
        provider_id: "vast",
        ssh_host: "ssh.example.invalid",
        ssh_port: 31234,
      }),
    );
    expect((await f.run(["instance-example"])).exit_code).toBe(0);
    expect(
      f.ctl_calls.find((call) => call.action === "create")?.input,
    ).toMatchObject({
      destination: "ssh.example.invalid",
      port: 31234,
      user: "root",
    });
  });

  test("rejects unsafe SSH endpoints and invalid provider ports", async () => {
    for (const fresh of [
      instance({
        public_ipv4: "",
        public_ipv6: "",
        ssh_host: "-oProxyCommand=example",
      }),
      instance({
        public_ipv4: "",
        public_ipv6: "",
        ssh_host: "host.example.invalid\nother",
      }),
      instance({ public_ipv4: "", public_ipv6: "" }),
      instance({ ssh_host: "ssh.example.invalid", ssh_port: 65536 }),
    ]) {
      const f = await fixture();
      f.setFresh(fresh);
      expect((await f.run(["instance-example"])).exit_code).toBe(1);
      expect(f.ctl_calls.some((call) => call.action !== "list")).toBe(false);
    }
  });

  test("validates override values before provider or ctl calls", async () => {
    for (const flags of [
      ["--port", "0"],
      ["--port", "65536"],
      ["--port", "2.5"],
      ["--port", "invalid"],
      ["--user", "-example"],
      ["--user", "bad\nuser"],
      ["--identity-file", ""],
    ]) {
      const f = await fixture();
      expect((await f.run(["instance-example", ...flags])).exit_code).toBe(1);
      expect(f.provider_calls).toEqual([]);
      expect(f.ctl_calls).toEqual([]);
    }
  });

  test("does not connect after provider or host synchronization failures", async () => {
    for (const stage of ["inventory", "get", "list", "create", "update"]) {
      const f = await fixture();
      if (stage === "update") f.hosts.push(savedHost());
      f.fail.set(
        stage,
        new AppError("provider_error", "Synthetic operation failed."),
      );
      const result = await f.run(["instance-example"]);
      expect(result.exit_code).toBe(1);
      expect(f.ctl_calls.some((call) => call.action === "connect")).toBe(false);
      expect(result.stderr).toContain("Synthetic operation failed.");
    }
  });

  for (const operation of ["create", "update"] as const) {
    test(`rejects an unexpected saved identity after host ${operation}`, async () => {
      const f = await fixture();
      if (operation === "update") f.hosts.push(savedHost());
      const withWrongIdentity = (host: CtlHost): CtlHost => ({
        ...host,
        connection_methods: host.connection_methods.map((method) => ({
          ...method,
          target: { ...method.target, identity_file: "/example/ssh/wrong-key" },
        })),
      });
      if (operation === "create") {
        const create = f.ctl.createHost.bind(f.ctl);
        f.ctl.createHost = async (input) =>
          withWrongIdentity(await create(input));
      } else {
        const update = f.ctl.updateHost.bind(f.ctl);
        f.ctl.updateHost = async (host_id, method_id, input) =>
          withWrongIdentity(await update(host_id, method_id, input));
      }
      const result = await f.run([
        "instance-example",
        "--identity-file",
        "/example/ssh/id-test",
      ]);
      expect(result.exit_code).toBe(1);
      expect(result.stderr).toContain(
        "ctl did not save the expected instance connection.",
      );
      expect(f.ctl_calls.some((call) => call.action === operation)).toBe(true);
      expect(f.ctl_calls.some((call) => call.action === "connect")).toBe(false);
    });
  }

  test("propagates ctl connection exit status", async () => {
    const f = await fixture();
    f.setConnectionExitCode(255);
    expect((await f.run(["instance-example"])).exit_code).toBe(255);
    expect(f.ctl_calls.at(-1)?.action).toBe("connect");
  });

  test("previews creation and updates without saving or connecting", async () => {
    for (const saved of [false, true]) {
      const f = await fixture();
      if (saved) f.hosts.push(savedHost());
      const result = await f.run(["instance-example", "--dry-run", "--json"]);
      expect(result.exit_code).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output).toMatchObject({
        account_id,
        provider_id: "vultr",
        action: "instance.login",
        data: {
          instance_id: "instance-example",
          host_name: managedName(),
          operation: saved ? "update" : "create",
          connection: { host: "192.0.2.10", port: 22, user: "root" },
        },
      });
      expect(f.ctl_calls).toEqual([{ action: "list" }]);
      expect(f.provider_calls).toContain("get:instance-example");
      expect(result.stdout + result.stderr).not.toContain(synthetic_secret);
    }
  });

  test("rejects JSON connection sessions before any provider or ctl activity", async () => {
    const f = await fixture();
    const result = await f.run(["instance-example", "--json"]);
    expect(result.exit_code).toBe(1);
    expect(JSON.parse(result.stderr).error.code).toBe("invalid_input");
    expect(f.provider_calls).toEqual([]);
    expect(f.ctl_calls).toEqual([]);
  });

  test("can select an instance for a human dry run without saving or connecting", async () => {
    const f = await fixture();
    const result = await f.run(["--dry-run"], { interactive: true });
    expect(result.exit_code).toBe(0);
    expect(result.prompts).toHaveLength(1);
    expect(f.ctl_calls).toEqual([{ action: "list" }]);
  });

  test("does not prompt in JSON dry-run mode", async () => {
    const f = await fixture();
    const result = await f.run(["--json", "--dry-run"], { interactive: true });
    expect(result.exit_code).toBe(1);
    expect(JSON.parse(result.stderr).error.code).toBe("invalid_input");
    expect(result.prompts).toEqual([]);
    expect(f.provider_calls).toEqual([]);
    expect(f.ctl_calls).toEqual([]);
  });

  test("fetches a provider password before saving and passes it only to the connection", async () => {
    for (const existing of [false, true]) {
      const f = await fixture();
      if (existing) f.hosts.push(savedHost());
      f.setFresh(instance({ public_ipv4: "192.0.2.20", ssh_port: 2222 }));
      f.setLoginCredential({ user: "root", password: synthetic_password });
      const original_config = await readFile(f.config_path, "utf8");

      const result = await f.run(["instance-example"]);

      expect(result.exit_code).toBe(0);
      expect(
        f.provider_calls.filter((call) => call.startsWith("credential:")),
      ).toEqual(["credential:instance-example"]);
      expect(f.trace.indexOf("provider:get")).toBeLessThan(
        f.trace.indexOf("provider:credential"),
      );
      expect(f.trace.indexOf("provider:credential")).toBeLessThan(
        f.trace.indexOf(existing ? "ctl:update" : "ctl:create"),
      );
      expect(f.ctl_calls.at(-1)).toEqual({
        action: "connect",
        host_id: existing ? "host-example" : "host-created-1",
        method_id: existing ? "method-example" : "method-created",
        authentication: expect.objectContaining({
          user: "root",
          host: "192.0.2.20",
          port: 2222,
          password: synthetic_password,
        }),
      });
      expect(
        JSON.stringify(
          f.ctl_calls.filter((call) => call.action !== "connect"),
        ) +
          JSON.stringify(f.hosts) +
          result.stdout +
          result.stderr,
      ).not.toContain(synthetic_password);
      expect(await readFile(f.config_path, "utf8")).toBe(original_config);
      expect(result.stdout + result.stderr).not.toContain(synthetic_secret);
    }
  });

  test("uses the credential username ahead of a stale saved username", async () => {
    const f = await fixture();
    f.hosts.push(savedHost());
    const fresh = instance();
    delete fresh.ssh_user;
    f.setFresh(fresh);
    f.setLoginCredential({ user: "linuxuser", password: synthetic_password });

    const result = await f.run(["instance-example"], { interactive: true });

    expect(result.exit_code).toBe(0);
    expect(result.text_prompts).toEqual([]);
    expect(
      f.ctl_calls.find((call) => call.action === "update")?.input?.user,
    ).toBe("linuxuser");
    expect(f.ctl_calls.at(-1)?.authentication?.user).toBe("linuxuser");
  });

  test("uses the provider username without prompting when instance metadata omits it", async () => {
    const f = await fixture();
    const fresh = instance();
    delete fresh.ssh_user;
    f.setFresh(fresh);
    f.setLoginCredential({ user: "root", password: synthetic_password });

    const result = await f.run(["instance-example"]);

    expect(result.exit_code).toBe(0);
    expect(result.text_prompts).toEqual([]);
    expect(f.ctl_calls.at(-1)?.authentication?.user).toBe("root");
  });

  test("permits a matching username override and binds the password to the selected port", async () => {
    const f = await fixture();
    f.setLoginCredential({ user: "root", password: synthetic_password });

    const result = await f.run([
      "instance-example",
      "--user",
      "root",
      "--port",
      "2200",
    ]);

    expect(result.exit_code).toBe(0);
    expect(f.ctl_calls.at(-1)?.authentication).toMatchObject({
      user: "root",
      host: "192.0.2.10",
      port: 2200,
      password: synthetic_password,
    });
  });

  test("rejects a different username before saving or connecting with another user's password", async () => {
    const f = await fixture();
    f.setLoginCredential({ user: "root", password: synthetic_password });

    const result = await f.run(["instance-example", "--user", "other-user"]);

    expect(result.exit_code).toBe(1);
    expect(f.ctl_calls.every((call) => call.action === "list")).toBe(true);
    expect(result.stdout + result.stderr).not.toContain(synthetic_password);
  });

  test("rejects a credential username that disagrees with the reported instance username", async () => {
    const f = await fixture();
    f.setLoginCredential({ user: "linuxuser", password: synthetic_password });

    const result = await f.run(["instance-example"]);

    expect(result.exit_code).toBe(1);
    expect(f.ctl_calls.every((call) => call.action === "list")).toBe(true);
    expect(result.stdout + result.stderr).not.toContain(synthetic_password);
  });

  test("rejects routed password connections before saving so route prerequisites cannot use Keychain", async () => {
    for (const route of [
      { vpn_connection_id: "example-vpn" },
      { gateway_route: [{ kind: "ssh", gateway_id: "example-gateway" }] },
      { gateways: [{ destination: "gateway.example.invalid" }] },
    ]) {
      const f = await fixture();
      const saved = savedHost();
      const method = saved.connection_methods[0];
      if (!method) throw new Error("Missing synthetic method.");
      Object.assign(method.target, route);
      f.hosts.push(saved);
      f.setLoginCredential({ user: "root", password: synthetic_password });

      const result = await f.run(["instance-example"]);

      expect(result.exit_code).toBe(1);
      expect(result.stderr).toContain("direct ctl connection");
      expect(f.ctl_calls).toEqual([{ action: "list" }]);
      expect(result.stdout + result.stderr).not.toContain(synthetic_password);
    }
  });

  for (const operation of ["create", "update"] as const) {
    test(`rejects a route added to the saved ${operation} response before passing a provider password`, async () => {
      const f = await fixture();
      if (operation === "update") f.hosts.push(savedHost());
      f.setLoginCredential({ user: "root", password: synthetic_password });
      const injectRoute = (saved: CtlHost): CtlHost => {
        const method = saved.connection_methods[0];
        if (!method) throw new Error("Missing synthetic method.");
        method.target.gateway_route = [
          { kind: "ssh", gateway_id: "example-gateway" },
        ];
        return saved;
      };
      if (operation === "create") {
        const create = f.ctl.createHost.bind(f.ctl);
        f.ctl.createHost = async (input) => injectRoute(await create(input));
      } else {
        const update = f.ctl.updateHost.bind(f.ctl);
        f.ctl.updateHost = async (host_id, method_id, input) =>
          injectRoute(await update(host_id, method_id, input));
      }

      const result = await f.run(["instance-example"]);

      expect(result.exit_code).toBe(1);
      expect(f.ctl_calls.some((call) => call.action === operation)).toBe(true);
      expect(f.ctl_calls.some((call) => call.action === "connect")).toBe(false);
      expect(result.stdout + result.stderr).not.toContain(synthetic_password);
    });
  }

  test("retains a direct saved key reference while passing the provider password only transiently", async () => {
    const f = await fixture();
    const saved = savedHost();
    const method = saved.connection_methods[0];
    if (!method) throw new Error("Missing synthetic method.");
    method.target.identity_file = "/example/ssh/id-test";
    f.hosts.push(saved);
    f.setLoginCredential({ user: "root", password: synthetic_password });

    const result = await f.run(["instance-example"]);

    expect(result.exit_code).toBe(0);
    expect(f.hosts[0]?.connection_methods[0]?.target.identity_file).toBe(
      "/example/ssh/id-test",
    );
    expect(
      f.ctl_calls.find((call) => call.action === "update")?.input,
    ).not.toHaveProperty("password");
    expect(f.ctl_calls.at(-1)?.authentication?.password).toBe(
      synthetic_password,
    );
  });

  test("does not fetch or expose passwords in human or JSON dry-run previews", async () => {
    for (const args of [["--dry-run"], ["--dry-run", "--json"]]) {
      const f = await fixture();
      f.setLoginCredential({ user: "root", password: synthetic_password });
      f.fail.set("credential", new Error("Unexpected credential retrieval."));

      const result = await f.run(["instance-example", ...args]);

      expect(result.exit_code).toBe(0);
      expect(
        f.provider_calls.some((call) => call.startsWith("credential:")),
      ).toBe(false);
      expect(f.ctl_calls).toEqual([{ action: "list" }]);
      expect(result.stdout + result.stderr).not.toContain(synthetic_password);
      expect(result.stdout + result.stderr).not.toContain("password");
      if (args.includes("--json")) {
        expect(JSON.parse(result.stdout).data.auth_method).toBe("provider");
      }
    }
  });

  test("reports the explicit ctl authentication choice in previews without fetching a password", async () => {
    const f = await fixture();
    f.setLoginCredential({ user: "root", password: synthetic_password });

    const result = await f.run([
      "instance-example",
      "--auth",
      "ctl",
      "--dry-run",
      "--json",
    ]);

    expect(result.exit_code).toBe(0);
    expect(JSON.parse(result.stdout).data.auth_method).toBe("ctl");
    expect(
      f.provider_calls.some((call) => call.startsWith("credential:")),
    ).toBe(false);
    expect(f.ctl_calls).toEqual([{ action: "list" }]);
    expect(result.stdout + result.stderr).not.toContain(synthetic_password);
  });

  test("rejects an unknown authentication mode before provider or ctl calls", async () => {
    const f = await fixture();

    const result = await f.run(["instance-example", "--auth", "unknown"]);

    expect(result.exit_code).toBe(1);
    expect(f.provider_calls).toEqual([]);
    expect(f.ctl_calls).toEqual([]);
  });

  test("stops when a capable provider has no usable password without silently using Keychain", async () => {
    const f = await fixture();
    f.setLoginCredential(undefined);

    const result = await f.run(["instance-example"]);

    expect(result.exit_code).toBe(1);
    expect(f.provider_calls).toContain("credential:instance-example");
    expect(f.ctl_calls.every((call) => call.action === "list")).toBe(true);
    expect(result.stderr).toContain("--auth ctl");
  });

  test("only uses normal ctl authentication for a capable provider when explicitly requested", async () => {
    const f = await fixture();
    f.setLoginCredential({ user: "root", password: synthetic_password });
    f.fail.set("credential", new Error("Unexpected credential retrieval."));

    const result = await f.run(["instance-example", "--auth", "ctl"]);

    expect(result.exit_code).toBe(0);
    expect(
      f.provider_calls.some((call) => call.startsWith("credential:")),
    ).toBe(false);
    expect(f.ctl_calls.at(-1)).toEqual({
      action: "connect",
      host_id: "host-created-1",
      method_id: "method-created",
    });
  });

  test("retains saved routes when the user explicitly chooses ctl authentication", async () => {
    const f = await fixture();
    const saved = savedHost();
    const method = saved.connection_methods[0];
    if (!method) throw new Error("Missing synthetic method.");
    method.target.vpn_connection_id = "example-vpn";
    f.hosts.push(saved);
    f.setLoginCredential({ user: "root", password: synthetic_password });

    const result = await f.run(["instance-example", "--auth", "ctl"]);

    expect(result.exit_code).toBe(0);
    expect(
      f.provider_calls.some((call) => call.startsWith("credential:")),
    ).toBe(false);
    expect(f.hosts[0]?.connection_methods[0]?.target.vpn_connection_id).toBe(
      "example-vpn",
    );
    expect(f.ctl_calls.at(-1)?.authentication).toBeUndefined();
  });

  test("rejects provider-password authentication when the provider cannot supply a password", async () => {
    const f = await fixture("runpod");
    f.setFresh(
      instance({
        provider_id: "runpod",
        ssh_host: "server.example.invalid",
        ssh_port: 2222,
      }),
    );

    const result = await f.run(["instance-example", "--auth", "provider"]);

    expect(result.exit_code).toBe(1);
    expect(f.ctl_calls.some((call) => call.action !== "list")).toBe(false);
  });

  test("keeps providers without a credential operation on their existing authentication path", async () => {
    for (const provider_id of ["runpod", "vast"] as const) {
      const f = await fixture(provider_id);
      f.setFresh(
        instance({
          provider_id,
          ssh_host: "server.example.invalid",
          ssh_port: 2222,
        }),
      );

      const result = await f.run(["instance-example"]);

      expect(result.exit_code).toBe(0);
      expect(
        f.provider_calls.some((call) => call.startsWith("credential:")),
      ).toBe(false);
      expect(f.ctl_calls.at(-1)?.authentication).toBeUndefined();
    }
  });

  test("stops when credential retrieval fails without saving a host or falling back", async () => {
    for (const failure of [
      new Error(synthetic_password),
      new AppError("provider_error", synthetic_password),
    ]) {
      const f = await fixture();
      f.setLoginCredential({ user: "root", password: synthetic_password });
      f.fail.set("credential", failure);

      const result = await f.run(["instance-example"]);

      expect(result.exit_code).toBe(1);
      expect(f.ctl_calls.every((call) => call.action === "list")).toBe(true);
      expect(result.stdout + result.stderr).not.toContain(synthetic_password);
    }
  });

  test("rejects malformed credentials before saving or connecting without printing their values", async () => {
    for (const credential of [
      { user: "root", password: "" },
      { user: "root", password: `${synthetic_password}\nextra` },
      { user: "root", password: `${synthetic_password}\u0000extra` },
      { user: "root", password: synthetic_password.repeat(200) },
      { user: "invalid user", password: synthetic_password },
    ]) {
      const f = await fixture();
      f.setLoginCredential(credential);

      const result = await f.run(["instance-example"]);

      expect(result.exit_code).toBe(1);
      expect(f.ctl_calls.every((call) => call.action === "list")).toBe(true);
      expect(result.stdout + result.stderr).not.toContain(synthetic_password);
    }
  });

  test("does not fetch credentials for an invalid or stopped endpoint", async () => {
    for (const fresh of [
      instance({ status: "stopped" }),
      instance({ ssh_host: "-invalid", ssh_port: 22 }),
      instance({ id: "different-instance" }),
    ]) {
      const f = await fixture();
      f.setFresh(fresh);
      f.setLoginCredential({ user: "root", password: synthetic_password });

      const result = await f.run(["instance-example"]);

      expect(result.exit_code).toBe(1);
      expect(
        f.provider_calls.some((call) => call.startsWith("credential:")),
      ).toBe(false);
      expect(f.ctl_calls.some((call) => call.action !== "list")).toBe(false);
    }
  });

  test("propagates a failed password connection without exposing or retaining the secret", async () => {
    const f = await fixture();
    f.setLoginCredential({ user: "root", password: synthetic_password });
    f.setConnectionExitCode(255);

    const result = await f.run(["instance-example"]);

    expect(result.exit_code).toBe(255);
    expect(f.ctl_calls.at(-1)?.authentication?.password).toBe(
      synthetic_password,
    );
    expect(
      JSON.stringify(f.hosts) + result.stdout + result.stderr,
    ).not.toContain(synthetic_password);
  });
});
