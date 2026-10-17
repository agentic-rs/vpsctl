import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/commands/program.ts";
import { AccountStore } from "../src/core/accounts.ts";
import {
  InstanceCredentialStore,
  instanceCredentialPath,
} from "../src/core/instance-credentials.ts";
import type {
  Instance,
  InstanceLoginCredential,
  Provider,
  ProviderDefinition,
  ProviderInfo,
} from "../src/core/provider.ts";
import { ProviderRegistry } from "../src/core/registry.ts";

const temp_dirs: string[] = [];
const password = "synthetic-instance-password";
const key = {
  provider_id: "vultr",
  account_id: "alpha",
  instance_id: "created-instance",
};

interface FixtureOptions {
  captured?: InstanceLoginCredential;
  captured_id?: string;
  fetched?: InstanceLoginCredential;
  supports_password?: boolean;
  fetch_error?: boolean;
  create_error?: boolean;
  destroy_error?: boolean;
  returned_provider_id?: string;
  password_help?: NonNullable<ProviderInfo["instance_password_help"]>;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function fixture(options: FixtureOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "vpsctl-password-lifecycle-"));
  temp_dirs.push(directory);
  const config_path = join(directory, "config.json");
  const credential_path = instanceCredentialPath(config_path);
  const credential_store = new InstanceCredentialStore(credential_path);
  const account_store = new AccountStore(config_path);
  for (const account_id of ["alpha", "beta"]) {
    await account_store.add({
      id: account_id,
      provider_id: "vultr",
      credentials: {
        api_key: { source: "literal", value: "synthetic-api-key" },
      },
    });
  }
  await account_store.use("alpha");
  const calls: string[] = [];
  const info = {
    id: "vultr",
    name: "Test provider",
    capabilities: ["instances"],
    ...(options.password_help !== undefined
      ? { instance_password_help: options.password_help }
      : {}),
  };
  const instance: Instance = {
    provider_id: options.returned_provider_id ?? "vultr",
    id: key.instance_id,
    label: "example-instance",
    region_id: "example-region",
    plan_id: "example-plan",
    image_id: "example-image",
    status: "running",
    provider_status: "active",
    power_status: "running",
    server_status: "ok",
    public_ipv4: "192.0.2.10",
    public_ipv6: "",
    tags: [],
  };
  const provider: Provider = {
    info,
    async listInstances() {
      return [instance];
    },
    async getInstance() {
      return instance;
    },
    async createInstance(_input, creation_options) {
      calls.push("create");
      if (options.captured !== undefined) {
        creation_options?.on_login_credential?.(
          options.captured_id ?? instance.id,
          options.captured,
        );
      }
      if (options.create_error) throw new Error("Creation failed.");
      return instance;
    },
    async editInstance() {
      return instance;
    },
    async destroyInstance() {
      calls.push("destroy");
      if (options.destroy_error) throw new Error("Destruction failed.");
    },
    async startInstance() {},
    async stopInstance() {},
    async rebootInstance() {},
    async listRegions() {
      return [];
    },
    async listPlans() {
      return [];
    },
    async listImages() {
      return [];
    },
    async listSshKeys() {
      return [];
    },
    ...(options.supports_password === false
      ? {}
      : {
          async getInstanceLoginCredential(instance_id: string) {
            calls.push(`credential:${instance_id}`);
            if (options.fetch_error) throw new Error(password);
            return options.fetched;
          },
        }),
  };
  const definition: ProviderDefinition = {
    info,
    credential_fields: ["api_key"],
    create() {
      return provider;
    },
  };
  const run = async (
    args: string[],
    prompt_options: { is_interactive?: boolean; confirmation?: boolean } = {},
  ) => {
    const output: string[] = [];
    const errors: string[] = [];
    let secret_prompts = 0;
    let confirmations = 0;
    const exit_code = await runCli(["--config", config_path, ...args], {
      env: {},
      registry: new ProviderRegistry([definition]),
      io: {
        is_interactive: prompt_options.is_interactive ?? false,
        write_out(text) {
          output.push(text);
        },
        write_err(text) {
          errors.push(text);
        },
        async confirm() {
          confirmations += 1;
          return prompt_options.confirmation ?? false;
        },
        async read_secret() {
          secret_prompts += 1;
          throw new Error("Unexpected password prompt.");
        },
      },
    });
    return {
      exit_code,
      stdout: output.join(""),
      stderr: errors.join(""),
      secret_prompts,
      confirmations,
    };
  };
  return { run, credential_store, credential_path, calls };
}

afterEach(async () => {
  await Promise.all(
    temp_dirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("instance password creation lifecycle", () => {
  test("saves the creation response password without another provider read or prompts", async () => {
    const credential = { user: "root", password };
    const { run, credential_store, calls } = await fixture({
      captured: credential,
    });
    const result = await run(["instance", "create", "--yes", "--json"]);
    expect(result.exit_code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.secret_prompts).toBe(0);
    expect(result.confirmations).toBe(0);
    expect(calls).toEqual(["create"]);
    expect(await credential_store.get(key)).toEqual(credential);
    expect(JSON.parse(result.stdout)).toMatchObject({
      action: "instance.create",
      data: { id: key.instance_id },
    });
    expect(result.stdout).not.toContain(password);
    expect(result.stderr).not.toContain(password);
  });

  test("preserves a creation password even when the provider omits its SSH username", async () => {
    const { run, credential_store, calls } = await fixture({
      captured: { password },
    });
    const result = await run(["instance", "create", "--yes", "--json"]);
    expect(result.exit_code).toBe(0);
    expect(calls).toEqual(["create"]);
    expect(await credential_store.get(key)).toEqual({ password });
  });

  test("reads the password once after creation when it was absent from the response", async () => {
    const credential = { user: "root", password };
    const { run, credential_store, calls } = await fixture({
      fetched: credential,
    });
    const result = await run(["instance", "create", "--yes", "--json"]);
    expect(result.exit_code).toBe(0);
    expect(result.stderr).toBe("");
    expect(calls).toEqual(["create", `credential:${key.instance_id}`]);
    expect(await credential_store.get(key)).toEqual(credential);
  });

  test("does not save a captured password under a different instance ID", async () => {
    const { run, credential_store, calls } = await fixture({
      captured: { user: "root", password: "other-instance-password" },
      captured_id: "another-instance",
      fetched: { user: "root", password },
    });
    const result = await run(["instance", "create", "--yes", "--json"]);
    expect(result.exit_code).toBe(0);
    expect(calls).toEqual(["create", `credential:${key.instance_id}`]);
    expect(await credential_store.get(key)).toEqual({ user: "root", password });
    expect(
      await credential_store.get({ ...key, instance_id: "another-instance" }),
    ).toBeUndefined();
  });

  test.each([false, true])(
    "does not fetch or bind a password when the created provider identity mismatches (captured=%s)",
    async (capture_password) => {
      const credential = { user: "root", password };
      const { run, credential_path, calls } = await fixture({
        ...(capture_password ? { captured: credential } : {}),
        fetched: credential,
        returned_provider_id: "other-provider",
      });
      const result = await run(["instance", "create", "--yes", "--json"]);
      expect(result.exit_code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        action: "instance.create",
        data: { id: key.instance_id, provider_id: "other-provider" },
      });
      expect(calls).toEqual(["create"]);
      expect(await exists(credential_path)).toBe(false);
      expect(result.stderr).toContain("instance was created");
      expect(result.stderr).not.toContain(password);
    },
  );

  test.each([false, true])(
    "keeps successful creation visible when password retrieval is unavailable (error=%s)",
    async (fetch_error) => {
      const { run, credential_store, calls } = await fixture({ fetch_error });
      const result = await run(["instance", "create", "--yes", "--json"]);
      expect(result.exit_code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        action: "instance.create",
        data: { id: key.instance_id },
      });
      expect(result.stderr).toContain("instance was created");
      expect(result.stderr).toContain("provider website");
      expect(result.stdout).not.toContain(password);
      expect(result.stderr).not.toContain(password);
      expect(calls).toEqual(["create", `credential:${key.instance_id}`]);
      expect(await credential_store.get(key)).toBeUndefined();
    },
  );

  test("provides sanitized provider website instructions and a masked-entry next step after creation", async () => {
    const { run } = await fixture({
      password_help: {
        url: "https://console.example.test/instances\u001b",
        instructions: "Open Overview\u001b and reveal the root password.",
      },
    });
    const result = await run(["instance", "create", "--yes", "--json"]);
    expect(result.exit_code).toBe(0);
    expect(result.stderr).toContain("https://console.example.test/instances");
    expect(result.stderr).toContain("and reveal the root password");
    expect(result.stderr).toContain("instance login");
    expect(result.stderr).toContain("enter and save");
    expect(result.stderr).not.toContain("\u001b");
    expect(result.secret_prompts).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      action: "instance.create",
      data: { id: key.instance_id },
    });
  });

  test("reports successful paid creation when the local password store cannot be written", async () => {
    const { run, credential_path, calls } = await fixture({
      captured: { user: "root", password },
    });
    await writeFile(credential_path, `{${password}`, { mode: 0o600 });
    const result = await run(["instance", "create", "--yes", "--json"]);
    expect(result.exit_code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      data: { id: key.instance_id },
    });
    expect(result.stderr).toContain("instance was created");
    expect(result.stderr).not.toContain(password);
    expect(result.stderr).not.toContain(credential_path);
    expect(calls).toEqual(["create"]);
  });

  test("does not persist a credential captured before creation failed", async () => {
    const { run, credential_path, calls } = await fixture({
      captured: { user: "root", password },
      create_error: true,
    });
    const result = await run(["instance", "create", "--yes", "--json"]);
    expect(result.exit_code).toBe(1);
    expect(calls).toEqual(["create"]);
    expect(await exists(credential_path)).toBe(false);
  });

  test("does not access password storage for providers without password support", async () => {
    const { run, credential_path, calls } = await fixture({
      supports_password: false,
    });
    const result = await run(["instance", "create", "--yes", "--json"]);
    expect(result.exit_code).toBe(0);
    expect(result.stderr).toBe("");
    expect(calls).toEqual(["create"]);
    expect(await exists(credential_path)).toBe(false);
  });

  test("dry runs and declined creation never fetch or persist passwords", async () => {
    const { run, credential_path, calls } = await fixture({
      captured: { user: "root", password },
      fetched: { user: "root", password },
    });
    const preview = await run(["instance", "create", "--dry-run", "--json"]);
    const declined = await run(["instance", "create"], {
      is_interactive: true,
      confirmation: false,
    });
    expect(preview.exit_code).toBe(0);
    expect(declined.exit_code).toBe(0);
    expect(declined.confirmations).toBe(1);
    expect(calls).toEqual([]);
    expect(await exists(credential_path)).toBe(false);
  });
});

describe("instance password destruction lifecycle", () => {
  test("removes only the destroyed instance credential in the selected account and provider", async () => {
    const { run, credential_store, calls } = await fixture();
    const other_keys = [
      { ...key, account_id: "beta" },
      { ...key, provider_id: "other-provider" },
      { ...key, instance_id: "another-instance" },
    ];
    for (const saved_key of [key, ...other_keys]) {
      await credential_store.set(saved_key, { user: "root", password });
    }
    const result = await run([
      "instance",
      "destroy",
      key.instance_id,
      "--yes",
      "--json",
    ]);
    expect(result.exit_code).toBe(0);
    expect(result.stderr).toBe("");
    expect(calls).toEqual(["destroy"]);
    expect(await credential_store.get(key)).toBeUndefined();
    for (const saved_key of other_keys) {
      expect(await credential_store.get(saved_key)).toEqual({
        user: "root",
        password,
      });
    }
  });

  test("retains the saved password when destruction fails", async () => {
    const { run, credential_store, calls } = await fixture({
      destroy_error: true,
    });
    await credential_store.set(key, { user: "root", password });
    const result = await run([
      "instance",
      "destroy",
      key.instance_id,
      "--yes",
      "--json",
    ]);
    expect(result.exit_code).toBe(1);
    expect(calls).toEqual(["destroy"]);
    expect(await credential_store.get(key)).toEqual({ user: "root", password });
  });

  test("reports successful destruction when credential cleanup fails without retrying", async () => {
    const { run, credential_path, calls } = await fixture();
    await writeFile(credential_path, `{${password}`, { mode: 0o600 });
    const result = await run([
      "instance",
      "destroy",
      key.instance_id,
      "--yes",
      "--json",
    ]);
    expect(result.exit_code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      action: "instance.destroy",
      data: { status: "accepted", instance_id: key.instance_id },
    });
    expect(result.stderr).toContain("instance was destroyed");
    expect(result.stderr).not.toContain(password);
    expect(result.stderr).not.toContain(credential_path);
    expect(calls).toEqual(["destroy"]);
  });
});
