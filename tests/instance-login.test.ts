import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
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
import type {
  Instance,
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
}

interface RunOptions {
  interactive?: boolean;
  selections?: Record<string, string>;
  cancel_prompt?: string;
  username?: string;
}

const temp_dirs: string[] = [];
const account_id = "sample-primary";
const second_account_id = "sample-secondary";
const synthetic_secret = "synthetic-provider-api-key";

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
  const info = {
    id: provider_id,
    name: "Example provider",
    capabilities: ["instances"],
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
    async connect(host_id, method_id) {
      ctl_calls.push({ action: "connect", host_id, method_id });
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
      async read_secret() {
        throw new Error(
          "Provider credentials must not be prompted for SSH login.",
        );
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
    };
  };
  return {
    run,
    store,
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
});
