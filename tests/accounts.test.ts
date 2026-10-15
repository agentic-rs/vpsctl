import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Account,
  AccountStore,
  defaultConfigPath,
  resolveAccount,
  resolveCredentials,
} from "../src/core/accounts.ts";
import { AppError } from "../src/core/errors.ts";

const temp_dirs: string[] = [];

async function fixture(): Promise<{
  config_path: string;
  store: AccountStore;
}> {
  const temp_dir = await mkdtemp(join(tmpdir(), "vps-ctl-accounts-"));
  temp_dirs.push(temp_dir);
  const config_path = join(temp_dir, "nested", "config.json");
  return { config_path, store: new AccountStore(config_path) };
}

function account(id: string, name = "VULTR_WORK_TOKEN"): Account {
  return {
    id,
    provider_id: "vultr",
    credentials: { api_key: { source: "env", name } },
  };
}

afterEach(async () => {
  await Promise.all(
    temp_dirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("AccountStore", () => {
  test("reads a missing config without creating files", async () => {
    const { store, config_path } = await fixture();
    expect(await store.read()).toEqual({ version: 1, accounts: [] });
    expect(await Bun.file(config_path).exists()).toBe(false);
  });

  test("roundtrips multiple accounts and sets a default explicitly", async () => {
    const { store, config_path } = await fixture();
    const work = account("work");
    const personal = account("personal", "VULTR_PERSONAL_TOKEN");
    expect(await store.add(work)).toEqual({ version: 1, accounts: [work] });
    expect(() => resolveAccount({ version: 1, accounts: [work] })).toThrow(
      "Select an account",
    );
    await store.add(personal);
    await store.use("work");
    const reopened = await new AccountStore(config_path).read();
    expect(reopened).toEqual({
      version: 1,
      default_account_id: "work",
      accounts: [work, personal],
    });
    expect(resolveAccount(reopened)).toEqual(work);
    expect(resolveAccount(reopened, "personal")).toEqual(personal);
    expect(() => resolveAccount(reopened, "unknown")).toThrow(
      "Account not found",
    );
    expect((await stat(config_path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(config_path, ".."))).mode & 0o777).toBe(0o700);
  });

  test("rejects duplicate account IDs and unknown remove/use without changing data", async () => {
    const { store, config_path } = await fixture();
    await store.add(account("work"));
    const original = await readFile(config_path, "utf8");
    await expect(
      store.add(account("work", "OTHER_TOKEN")),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(store.remove("unknown")).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(store.use("unknown")).rejects.toMatchObject({
      code: "not_found",
    });
    expect(await readFile(config_path, "utf8")).toBe(original);
    expect(await readdir(join(config_path, ".."))).toEqual(["config.json"]);
  });

  test("removing the default clears selection without selecting another account", async () => {
    const { store } = await fixture();
    await store.add(account("work"));
    await store.add(account("personal"));
    await store.use("work");
    const config = await store.remove("work");
    expect(config).toEqual({ version: 1, accounts: [account("personal")] });
    expect(await store.read()).toEqual(config);
    expect(() => resolveAccount(config)).toThrow("Select an account");
  });

  test("rejects invalid account input and unsupported credential objects", async () => {
    const { store, config_path } = await fixture();
    const invalid_accounts: unknown[] = [
      { ...account("work"), id: "../work" },
      { ...account("work"), id: "a".repeat(65) },
      { ...account("work"), provider_id: "invalid/provider" },
      { ...account("work"), credentials: {} },
      {
        ...account("work"),
        credentials: {
          api_key: { source: "inline", value: "must-not-persist" },
        },
      },
      {
        ...account("work"),
        credentials: {
          api_key: { source: "env", name: "TOKEN", value: "must-not-persist" },
        },
      },
      {
        ...account("work"),
        credentials: { api_key: { source: "env", name: "invalid-token" } },
      },
      { ...account("work"), credentials: { api_key: "must-not-persist" } },
    ];
    for (const invalid_account of invalid_accounts) {
      await expect(store.add(invalid_account as Account)).rejects.toMatchObject(
        { code: "invalid_input" },
      );
    }
    expect(await Bun.file(config_path).exists()).toBe(false);
  });

  test("persists environment references without resolved credentials", async () => {
    const { store, config_path } = await fixture();
    const work = account("work");
    expect(
      resolveCredentials(work, { VULTR_WORK_TOKEN: "temporary-secret-value" }),
    ).toEqual({
      api_key: "temporary-secret-value",
    });
    await store.add(work);
    const contents = await readFile(config_path, "utf8");
    expect(contents).toContain("VULTR_WORK_TOKEN");
    expect(contents).not.toContain("temporary-secret-value");
    expect(await store.read()).toEqual({ version: 1, accounts: [work] });
  });

  test("roundtrips literal credentials in a private configuration file", async () => {
    const { store, config_path } = await fixture();
    const work: Account = {
      id: "work",
      provider_id: "vultr",
      credentials: {
        api_key: { source: "literal", value: "local-test-credential" },
      },
    };
    await store.add(work);
    await store.use(work.id);
    const config = await new AccountStore(config_path).read();
    expect(resolveAccount(config)).toEqual(work);
    expect(resolveCredentials(resolveAccount(config), {})).toEqual({
      api_key: "local-test-credential",
    });
    expect((await stat(config_path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(config_path, "utf8"))).toEqual(config);
  });

  test("rejects malformed literal credentials without exposing their contents", async () => {
    const { store, config_path } = await fixture();
    const credential_values: unknown[] = [
      { source: "literal", value: "" },
      { source: "literal", value: "   " },
      { source: "literal", value: 42 },
      { source: "literal" },
      { source: "literal", value: "invalid-private-value", name: "TOKEN" },
    ];
    for (const credential of credential_values) {
      const malformed = {
        ...account("work"),
        credentials: { api_key: credential },
      } as Account;
      await expect(store.add(malformed)).rejects.toMatchObject({
        code: "invalid_input",
        message: "Invalid account configuration.",
      });
      expect(() => resolveCredentials(malformed, {})).toThrow(
        "Invalid account configuration.",
      );
    }
    expect(await Bun.file(config_path).exists()).toBe(false);
    await mkdir(join(config_path, ".."), { recursive: true });
    await writeFile(
      config_path,
      JSON.stringify({
        version: 1,
        accounts: [
          {
            ...account("work"),
            credentials: { api_key: credential_values[4] },
          },
        ],
      }),
    );
    await expect(store.read()).rejects.toMatchObject({
      code: "invalid_input",
      message: "Invalid account configuration file.",
    });
  });

  test("does not overwrite malformed existing configuration", async () => {
    const { store, config_path } = await fixture();
    await mkdir(join(config_path, ".."), { recursive: true });
    const invalid_configs: unknown[] = [
      { version: 2, accounts: [] },
      { version: 1, accounts: [account("work"), account("work")] },
      { version: 1, accounts: [], default_account_id: "missing" },
      { version: 1, accounts: [], unknown: true },
      {
        version: 1,
        accounts: [
          {
            ...account("work"),
            credentials: {
              api_key: { source: "plain", value: "private-value" },
            },
          },
        ],
      },
    ];
    const contents = [
      "{malformed private-value",
      ...invalid_configs.map((value) => JSON.stringify(value)),
    ];
    for (const original of contents) {
      await writeFile(config_path, original);
      await expect(store.read()).rejects.toMatchObject({
        code: "invalid_input",
      });
      await expect(store.add(account("new"))).rejects.toMatchObject({
        code: "invalid_input",
      });
      expect(await readFile(config_path, "utf8")).toBe(original);
      expect(await readdir(join(config_path, ".."))).toEqual(["config.json"]);
    }
  });

  test("fails cleanly when a writer holds the lock", async () => {
    const { store, config_path } = await fixture();
    await store.add(account("work"));
    const lock_path = `${config_path}.lock`;
    await writeFile(lock_path, "existing writer");
    await expect(store.add(account("personal"))).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await readFile(lock_path, "utf8")).toBe("existing writer");
    expect((await store.read()).accounts.map(({ id }) => id)).toEqual(["work"]);
    await rm(lock_path);
    await store.add(account("personal"));
    expect((await store.read()).accounts).toHaveLength(2);
  });

  test("concurrent account updates cannot silently overwrite a successful write", async () => {
    const { store, config_path } = await fixture();
    const accounts = Array.from({ length: 10 }, (_, index) =>
      account(`account_${index}`),
    );
    const results = await Promise.allSettled(
      accounts.map((entry) => new AccountStore(config_path).add(entry)),
    );
    const successful_ids = accounts.flatMap((entry, index) =>
      results[index]?.status === "fulfilled" ? [entry.id] : [],
    );
    expect(successful_ids.length).toBeGreaterThan(0);
    expect((await store.read()).accounts.map(({ id }) => id).sort()).toEqual(
      successful_ids.sort(),
    );
    for (const [index, result] of results.entries()) {
      if (result.status === "rejected") {
        expect(result.reason).toBeInstanceOf(AppError);
        expect(result.reason.code).toBe("conflict");
        const entry = accounts[index];
        if (entry) await store.add(entry);
      }
    }
    expect((await store.read()).accounts).toHaveLength(accounts.length);
    expect(await readdir(join(config_path, ".."))).toEqual(["config.json"]);
  });

  test("wraps filesystem errors without exposing raw system details", async () => {
    const { config_path } = await fixture();
    await mkdir(config_path, { recursive: true });
    await expect(new AccountStore(config_path).read()).rejects.toMatchObject({
      code: "invalid_input",
      message: "Unable to access account configuration.",
    });
    await rm(config_path, { recursive: true });
    await writeFile(config_path, "existing file");
    await expect(
      new AccountStore(join(config_path, "config.json")).add(account("work")),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: "Unable to access account configuration.",
    });
  });
});

describe("credential resolution", () => {
  test("resolves a mixture of literal and environment credentials", () => {
    const mixed: Account = {
      id: "mixed",
      provider_id: "future_provider",
      credentials: {
        api_key: { source: "literal", value: "local-test-credential" },
        api_secret: { source: "env", name: "FUTURE_PROVIDER_SECRET" },
      },
    };
    expect(
      resolveCredentials(mixed, {
        FUTURE_PROVIDER_SECRET: "env-test-credential",
      }),
    ).toEqual({
      api_key: "local-test-credential",
      api_secret: "env-test-credential",
    });
  });

  test("resolves only the selected account's environment references", () => {
    const env = {
      VULTR_WORK_TOKEN: "work-secret",
      VULTR_PERSONAL_TOKEN: "personal-secret",
    };
    expect(resolveCredentials(account("work"), env)).toEqual({
      api_key: "work-secret",
    });
    expect(
      resolveCredentials(account("personal", "VULTR_PERSONAL_TOKEN"), env),
    ).toEqual({ api_key: "personal-secret" });
    expect(
      resolveCredentials(account("work"), {
        VULTR_WORK_TOKEN: "rotated-secret",
      }),
    ).toEqual({ api_key: "rotated-secret" });
  });

  test("requires nonblank credentials and never includes values in errors", () => {
    for (const value of [undefined, "", "   "]) {
      expect(() =>
        resolveCredentials(account("work"), { VULTR_WORK_TOKEN: value }),
      ).toThrow("Missing credential environment variable: VULTR_WORK_TOKEN.");
    }
    expect(() =>
      resolveCredentials(account("work", "constructor"), {}),
    ).toThrow("Missing credential environment variable: constructor.");
  });
});

test("defaultConfigPath honors explicit path and XDG with a home fallback", () => {
  expect(
    defaultConfigPath({
      VPS_CTL_CONFIG: "/custom/accounts.json",
      XDG_CONFIG_HOME: "/xdg",
    }),
  ).toBe("/custom/accounts.json");
  expect(
    defaultConfigPath({ VPS_CTL_CONFIG: " ", XDG_CONFIG_HOME: "/xdg" }),
  ).toBe("/xdg/vps-ctl/config.json");
  expect(defaultConfigPath({ XDG_CONFIG_HOME: "" })).toMatch(
    /\/\.config\/vps-ctl\/config\.json$/,
  );
});
