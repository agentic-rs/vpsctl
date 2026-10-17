import { afterEach, describe, expect, test } from "bun:test";
import { constants } from "node:fs";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AppError } from "../src/core/errors.ts";
import {
  type InstanceCredentialKey,
  InstanceCredentialStore,
  instanceCredentialPath,
} from "../src/core/instance-credentials.ts";

const temp_dirs: string[] = [];
const key: InstanceCredentialKey = {
  provider_id: "vultr",
  account_id: "vultr:user@example.com",
  instance_id: "instance-example",
};
const credential = { user: "root", password: "synthetic-password-47!" };

async function fixture(nested = false): Promise<{
  directory: string;
  path: string;
  store: InstanceCredentialStore;
}> {
  const directory = await mkdtemp(
    join(tmpdir(), "vpsctl-instance-credentials-"),
  );
  temp_dirs.push(directory);
  const path = join(
    directory,
    ...(nested ? ["new", "nested"] : []),
    "credentials.local.json",
  );
  return { directory, path, store: new InstanceCredentialStore(path) };
}

async function writePrivate(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, { mode: 0o600 });
}

async function safeFailure(operation: Promise<unknown>): Promise<AppError> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect(String(error)).not.toContain(key.account_id);
    expect(String(error)).not.toContain(key.instance_id);
    expect(String(error)).not.toContain(credential.password);
    return error as AppError;
  }
  throw new Error("Expected the credential operation to fail.");
}

afterEach(async () => {
  await Promise.all(
    temp_dirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("instance credentials", () => {
  test("derives separate credential paths for each account configuration", () => {
    expect(instanceCredentialPath("settings.json")).toBe(
      "settings.json.instance-credentials.local.json",
    );
    expect(instanceCredentialPath("other.json")).not.toBe(
      instanceCredentialPath("settings.json"),
    );
  });

  test("reads missing and empty stores without creating files", async () => {
    const { directory, path, store } = await fixture();
    expect(await store.get(key)).toBeUndefined();
    expect(await readdir(directory)).toEqual([]);
    await writePrivate(path, " \n");
    expect(await store.get(key)).toBeUndefined();
    expect(await readFile(path, "utf8")).toBe(" \n");
    const nested = await fixture(true);
    expect(await nested.store.get(key)).toBeUndefined();
    expect(await readdir(nested.directory)).toEqual([]);
  });

  test("removing absent credentials creates no files or directories", async () => {
    const existing = await fixture();
    await existing.store.remove(key);
    expect(await readdir(existing.directory)).toEqual([]);
    const nested = await fixture(true);
    await nested.store.remove(key);
    expect(await readdir(nested.directory)).toEqual([]);
  });

  test("removing an unrelated key preserves the file and cleans up its lock", async () => {
    const { directory, path, store } = await fixture();
    await store.set(key, credential);
    const original_contents = await readFile(path, "utf8");
    const original_info = await stat(path);
    await store.remove({ ...key, instance_id: "missing-instance" });
    const current_info = await stat(path);
    expect(await readFile(path, "utf8")).toBe(original_contents);
    expect(current_info.ino).toBe(original_info.ino);
    expect(current_info.mtimeMs).toBe(original_info.mtimeMs);
    expect(await readdir(directory)).toEqual(["credentials.local.json"]);
    await store.set(key, { password: "replacement-synthetic-password" });
    expect(await store.get(key)).toEqual({
      password: "replacement-synthetic-password",
    });
  });

  test("removal checks for the credential after acquiring a writer's lock", async () => {
    const { directory, path, store } = await fixture();
    await store.set(key, credential);
    const pending_contents = await readFile(path, "utf8");
    await store.remove(key);
    await writePrivate(`${path}.lock`, "");
    const removal = store.remove(key);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await writePrivate(path, pending_contents);
    await rm(`${path}.lock`);
    await removal;
    expect(await store.get(key)).toBeUndefined();
    expect(await readdir(directory)).toEqual(["credentials.local.json"]);
  });

  test("saves owner-only credentials with a hash-only identity index", async () => {
    const { path, store } = await fixture(true);
    await store.set(key, credential);
    expect(await store.get(key)).toEqual(credential);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
    expect((await stat(dirname(dirname(path)))).mode & 0o777).toBe(0o700);
    const contents = await readFile(path, "utf8");
    expect(contents).not.toContain(key.provider_id);
    expect(contents).not.toContain(key.account_id);
    expect(contents).not.toContain(key.instance_id);
    const parsed = JSON.parse(contents);
    expect(Object.keys(parsed)).toEqual(["version", "credentials"]);
    expect(Object.keys(parsed.credentials)).toHaveLength(1);
    expect(Object.keys(parsed.credentials)[0]).toMatch(/^[a-f0-9]{64}$/);
  });

  test("persists unknown usernames without inventing a root binding", async () => {
    const { store } = await fixture();
    await store.set(key, { password: credential.password });
    expect(await store.get(key)).toEqual({ password: credential.password });
  });

  test("isolates provider, account, and instance identity and avoids tuple collisions", async () => {
    const { store } = await fixture();
    const keys = [
      key,
      { ...key, provider_id: "vast" },
      { ...key, account_id: "vultr:other@example.com" },
      { ...key, instance_id: "other-instance" },
      { provider_id: "a:b", account_id: "c", instance_id: "d" },
      { provider_id: "a", account_id: "b:c", instance_id: "d" },
    ];
    for (const [index, entry] of keys.entries()) {
      await store.set(entry, { password: `synthetic-secret-${index}` });
    }
    for (const [index, entry] of keys.entries()) {
      expect(await store.get(entry)).toEqual({
        password: `synthetic-secret-${index}`,
      });
    }
    await store.remove(keys[1] as InstanceCredentialKey);
    expect(await store.get(keys[1] as InstanceCredentialKey)).toBeUndefined();
    expect(await store.get(key)).toEqual({ password: "synthetic-secret-0" });
  });

  test("updates and deletes atomically while preserving unrelated entries", async () => {
    const { directory, path, store } = await fixture();
    const other_key = { ...key, instance_id: "other-instance" };
    await store.set(key, credential);
    await store.set(other_key, { password: "another-synthetic-password" });
    const before_update = await open(path, constants.O_RDONLY);
    try {
      await store.set(key, { user: "root", password: "replacement-password" });
      const old_contents = await before_update.readFile("utf8");
      expect(old_contents).toContain(credential.password);
      expect(old_contents).not.toContain("replacement-password");
    } finally {
      await before_update.close();
    }
    expect(await store.get(key)).toEqual({
      user: "root",
      password: "replacement-password",
    });
    await store.remove(key);
    expect(await store.get(key)).toBeUndefined();
    expect(await store.get(other_key)).toEqual({
      password: "another-synthetic-password",
    });
    await store.remove(key);
    expect(await readdir(directory)).toEqual(["credentials.local.json"]);
  });

  test("serializes concurrent writers without losing entries", async () => {
    const { directory, path, store } = await fixture();
    const keys = Array.from({ length: 16 }, (_, index) => ({
      ...key,
      instance_id: `synthetic-instance-${index}`,
    }));
    await Promise.all(
      keys.map((entry, index) =>
        new InstanceCredentialStore(path).set(entry, {
          password: `synthetic-password-${index}`,
        }),
      ),
    );
    for (const [index, entry] of keys.entries()) {
      expect(await store.get(entry)).toEqual({
        password: `synthetic-password-${index}`,
      });
    }
    expect(await readdir(directory)).toEqual(["credentials.local.json"]);
  });

  test("keeps configurations isolated even in the same directory", async () => {
    const { directory } = await fixture();
    const first = new InstanceCredentialStore(
      instanceCredentialPath(join(directory, "first.json")),
    );
    const second = new InstanceCredentialStore(
      instanceCredentialPath(join(directory, "second.json")),
    );
    await first.set(key, credential);
    expect(await second.get(key)).toBeUndefined();
    await second.set(key, { password: "different-synthetic-password" });
    expect(await first.get(key)).toEqual(credential);
  });

  test("fails closed on malformed content without replacing it or exposing values", async () => {
    for (const contents of [
      "not-json",
      JSON.stringify({ version: 2, credentials: {} }),
      JSON.stringify({
        version: 1,
        credentials: {},
        extra: credential.password,
      }),
      JSON.stringify({
        version: 1,
        credentials: { [key.account_id]: credential },
      }),
      JSON.stringify({
        version: 1,
        credentials: { ["a".repeat(64)]: { ...credential, extra: true } },
      }),
      JSON.stringify({
        version: 1,
        credentials: {
          ["a".repeat(64)]: { user: "root\n", password: credential.password },
        },
      }),
      JSON.stringify({
        version: 1,
        credentials: { ["a".repeat(64)]: { password: "" } },
      }),
      JSON.stringify({
        version: 1,
        credentials: { ["a".repeat(64)]: { password: "bad\npassword" } },
      }),
    ]) {
      const { directory, path, store } = await fixture();
      await writePrivate(path, contents);
      const error = await safeFailure(store.get(key));
      expect(error.message).not.toContain(path);
      await safeFailure(store.set(key, credential));
      expect(await readFile(path, "utf8")).toBe(contents);
      expect(await readdir(directory)).toEqual(["credentials.local.json"]);
    }
  });

  test("validates passwords and usernames before creating any files", async () => {
    const { directory, store } = await fixture();
    for (const value of [
      { password: "" },
      { password: "bad\u0000password" },
      { password: "x".repeat(4097) },
      { user: "root\n", password: credential.password },
      { user: "-unsafe", password: credential.password },
      { ...credential, extra: true },
    ]) {
      await safeFailure(store.set(key, value));
    }
    for (const entry of [
      { ...key, instance_id: "" },
      { ...key, account_id: "bad\nvalue" },
      { ...key, provider_id: "x".repeat(4097) },
    ]) {
      await safeFailure(store.set(entry, credential));
      await safeFailure(store.get(entry));
      await safeFailure(store.remove(entry));
    }
    expect(await readdir(directory)).toEqual([]);
  });

  test("refuses readable or writable shared files without changing their permissions", async () => {
    const { path, store } = await fixture();
    await store.set(key, credential);
    for (const mode of [0o644, 0o620, 0o604]) {
      await chmod(path, mode);
      await safeFailure(store.get(key));
      await safeFailure(store.set(key, credential));
      await safeFailure(store.remove(key));
      expect((await stat(path)).mode & 0o777).toBe(mode);
    }
  });

  test("refuses a shared directory without chmodding it", async () => {
    const { directory, store } = await fixture();
    await chmod(directory, 0o755);
    await safeFailure(store.get(key));
    await safeFailure(store.set(key, credential));
    expect((await stat(directory)).mode & 0o777).toBe(0o755);
    expect(await readdir(directory)).toEqual([]);
  });

  test("refuses symlink files and preserves their targets", async () => {
    const { directory, path, store } = await fixture();
    const target = join(directory, "target.json");
    await writePrivate(target, "synthetic-original-content");
    await symlink(target, path);
    await safeFailure(store.get(key));
    await safeFailure(store.set(key, credential));
    await safeFailure(store.remove(key));
    expect(await readFile(target, "utf8")).toBe("synthetic-original-content");
  });

  test("refuses a symlink credential directory", async () => {
    const { directory } = await fixture();
    const target = join(directory, "target");
    const shortcut = join(directory, "shortcut");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, shortcut);
    const store = new InstanceCredentialStore(
      join(shortcut, "credentials.local.json"),
    );
    await safeFailure(store.get(key));
    await safeFailure(store.set(key, credential));
    expect(await readdir(target)).toEqual([]);
  });

  test("refuses directory and hardlinked credential files", async () => {
    const first = await fixture();
    await mkdir(first.path, { mode: 0o700 });
    await safeFailure(first.store.get(key));
    await safeFailure(first.store.set(key, credential));
    const second = await fixture();
    await second.store.set(key, credential);
    await link(second.path, join(second.directory, "extra-link.json"));
    await safeFailure(second.store.get(key));
    await safeFailure(second.store.set(key, credential));
    expect(await readFile(second.path, "utf8")).toContain(credential.password);
  });

  test("refuses an untrusted lock without removing it or modifying its target", async () => {
    const { directory, path, store } = await fixture();
    const target = join(directory, "target.txt");
    await writePrivate(target, "leave-intact");
    await symlink(target, `${path}.lock`);
    await safeFailure(store.set(key, credential));
    expect(await readFile(target, "utf8")).toBe("leave-intact");
    expect(await readdir(directory)).toContain("credentials.local.json.lock");
  });

  test("waits for a live lock before writing", async () => {
    const { directory, path, store } = await fixture();
    await writePrivate(`${path}.lock`, "");
    const operation = store.set(key, credential);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await readdir(directory)).toEqual(["credentials.local.json.lock"]);
    await rm(`${path}.lock`);
    await operation;
    expect(await store.get(key)).toEqual(credential);
  });
});
