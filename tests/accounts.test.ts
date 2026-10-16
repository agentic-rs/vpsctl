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
  accountDisplayId,
  defaultConfigPath,
  deriveAccountId,
  findAccount,
  resolveAccount,
  resolveCredentialReferences,
  resolveCredentials,
  validateAccountId,
} from "../src/core/accounts.ts";
import { AppError } from "../src/core/errors.ts";

const temp_dirs: string[] = [];

async function fixture(): Promise<{
  config_path: string;
  store: AccountStore;
}> {
  const temp_dir = await mkdtemp(join(tmpdir(), "vpsctl-accounts-"));
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

describe("account IDs", () => {
  test("derives provider and email IDs while preserving email identity", () => {
    expect(
      deriveAccountId("vultr", "  Ops.Name+cloud%work@example.com  "),
    ).toBe("vultr:Ops.Name+cloud%work@example.com");
    expect(
      deriveAccountId("future_provider", "O'Neil@accounts.example.com"),
    ).toBe("future_provider:O'Neil@accounts.example.com");
    expect(deriveAccountId("vultr", "Ops@example.com")).not.toBe(
      deriveAccountId("vultr", "ops@example.com"),
    );
  });

  test("accepts legacy aliases and composite IDs longer than legacy aliases", () => {
    for (const id of ["work", "Work_2-personal", "a".repeat(64)]) {
      expect(validateAccountId(id)).toBe(id);
    }
    const email = `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`;
    expect(email).toHaveLength(254);
    const id = deriveAccountId("v".repeat(64), email);
    expect(id).toHaveLength(319);
    expect(validateAccountId(id)).toBe(id);
  });

  test("rejects malformed and unsafe account IDs", () => {
    const invalid_ids = [
      "",
      "a".repeat(65),
      "../work",
      "work personal",
      "work\n",
      "work\t",
      "a:b",
      ":user@example.com",
      "invalid/provider:user@example.com",
      `${"v".repeat(65)}:user@example.com`,
      "vultr:user@example.com:other",
      "vultr:user@example.com\n",
      " vultr:user@example.com",
      "vultr:user name@example.com",
      "vultr:user\u0000@example.com",
      "vultr:user/name@example.com",
      "vultr:user\\name@example.com",
      "vultr:.user@example.com",
      "vultr:user.@example.com",
      "vultr:user..name@example.com",
      "vultr:user@-example.com",
      "vultr:user@example-.com",
      "vultr:user@exa_mple.com",
      `vultr:${"a".repeat(65)}@example.com`,
      `vultr:user@${"a".repeat(64)}.com`,
      `vultr:${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(62)}`,
    ];
    for (const id of invalid_ids) {
      expect(() => validateAccountId(id)).toThrow(AppError);
    }
  });

  test("requires valid provider and email metadata to derive an ID", () => {
    for (const provider_id of [
      "",
      "vultr:other",
      "../vultr",
      "vultr\n",
      "v".repeat(65),
    ]) {
      expect(() => deriveAccountId(provider_id, "user@example.com")).toThrow(
        "Invalid provider ID.",
      );
    }
    for (const email of [
      "",
      "  ",
      "user",
      "user name@example.com",
      "user\nname@example.com",
      "user/name@example.com",
      "user..name@example.com",
      `${"u".repeat(65)}@example.com`,
    ]) {
      expect(() => deriveAccountId("vultr", email)).toThrow(
        "A valid account email is required",
      );
    }
  });
});

describe("account shortcuts", () => {
  test("resolves and displays a unique provider account regardless of its canonical ID", () => {
    const accounts = [
      account("vultr:user@example.com"),
      { ...account("gpu-work"), provider_id: "vast" },
      { ...account("runpod:user@example.com"), provider_id: "runpod" },
    ];
    for (const entry of accounts) {
      const config = { version: 1 as const, accounts };
      expect(findAccount(accounts, entry.provider_id)).toBe(entry);
      expect(resolveAccount(config, entry.provider_id)).toEqual(entry);
      expect(resolveAccount(config, entry.id)).toEqual(entry);
      expect(accountDisplayId(entry, accounts)).toBe(entry.provider_id);
    }
  });

  test("rejects ambiguous shortcuts but preserves full IDs and aliases", () => {
    const accounts = [account("vultr:user@example.com"), account("work")];
    const config = { version: 1 as const, accounts };
    expect(() => findAccount(accounts, "vultr")).toThrow(
      "Account shortcut is ambiguous. Use a full account ID from auth list.",
    );
    expect(() => resolveAccount(config, "vultr")).toThrow(AppError);
    for (const entry of accounts) {
      expect(resolveAccount(config, entry.id)).toEqual(entry);
      expect(accountDisplayId(entry, accounts)).toBe(entry.id);
    }
    try {
      findAccount(accounts, "vultr");
      throw new Error("Expected ambiguous account selection to fail.");
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid_input" });
      expect(String(error)).not.toContain("VULTR_WORK_TOKEN");
    }
  });

  test("gives exact IDs precedence when they collide with another provider shortcut", () => {
    const explicit_alias = account("vast");
    const provider_account = {
      ...account("vast:user@example.com"),
      provider_id: "vast",
    };
    const accounts = [explicit_alias, provider_account];
    expect(findAccount(accounts, "vast")).toBe(explicit_alias);
    expect(resolveAccount({ version: 1, accounts }, "vast")).toEqual(
      explicit_alias,
    );
    expect(accountDisplayId(explicit_alias, accounts)).toBe("vultr");
    expect(accountDisplayId(provider_account, accounts)).toBe(
      provider_account.id,
    );
  });

  test("preserves exact IDs even when multiple accounts share that provider", () => {
    const exact = account("vultr");
    const second = account("vultr:user@example.com");
    const accounts = [second, exact];
    expect(findAccount(accounts, "vultr")).toBe(exact);
    expect(accountDisplayId(exact, accounts)).toBe("vultr");
    expect(accountDisplayId(second, accounts)).toBe(second.id);
  });

  test("does not infer a missing selector or use a provider shortcut as a saved default", () => {
    const accounts = [account("vultr:user@example.com")];
    expect(findAccount(accounts, "missing")).toBeUndefined();
    expect(() => resolveAccount({ version: 1, accounts }, "missing")).toThrow(
      "Account not found.",
    );
    expect(() => resolveAccount({ version: 1, accounts })).toThrow(
      "Select an account",
    );
    expect(() =>
      resolveAccount({ version: 1, accounts, default_account_id: "vultr" }),
    ).toThrow("Invalid account configuration file.");
  });

  test("display shortcuts require no credentials and leave the source identities unchanged", () => {
    const identity = Object.freeze({
      id: "vultr:user@example.com",
      provider_id: "vultr",
    });
    const identities = Object.freeze([identity]);
    expect(accountDisplayId(identity, identities)).toBe("vultr");
    expect(identities).toEqual([
      { id: "vultr:user@example.com", provider_id: "vultr" },
    ]);
  });
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

  test("persists, selects, renews, and removes provider and email IDs alongside legacy aliases", async () => {
    const { store, config_path } = await fixture();
    const id = deriveAccountId("vultr", "Ops.Name+team@example.com");
    const derived = account(id);
    const personal = account("personal", "VULTR_PERSONAL_TOKEN");
    const other_provider: Account = {
      ...account(
        deriveAccountId("future_provider", "Ops.Name+team@example.com"),
      ),
      provider_id: "future_provider",
    };
    await store.add(derived);
    await store.add(personal);
    await store.add(other_provider);
    await store.use(id);
    const reopened = new AccountStore(config_path);
    const saved = await reopened.read();
    expect(saved).toEqual({
      version: 1,
      default_account_id: id,
      accounts: [derived, personal, other_provider],
    });
    expect(resolveAccount(saved)).toEqual(derived);
    expect(resolveAccount(saved, "personal")).toEqual(personal);
    expect(resolveAccount(saved, other_provider.id)).toEqual(other_provider);
    expect(() => resolveAccount(saved, id.toLowerCase())).toThrow(
      "Account not found.",
    );
    const renewed = account(id, "VULTR_RENEWED_TOKEN");
    expect(await reopened.save(renewed)).toEqual({
      ...saved,
      accounts: [renewed, personal, other_provider],
    });
    expect(await reopened.remove(id)).toEqual({
      version: 1,
      accounts: [personal, other_provider],
    });
    expect((await store.read()).default_account_id).toBeUndefined();
  });

  test("saves a new account in a private configuration file without selecting a default", async () => {
    const { store, config_path } = await fixture();
    const work = account("work");
    expect(await store.save(work)).toEqual({ version: 1, accounts: [work] });
    expect(await new AccountStore(config_path).read()).toEqual({
      version: 1,
      accounts: [work],
    });
    expect((await stat(config_path)).mode & 0o777).toBe(0o600);
  });

  test("saves replacement credentials while preserving the default and unrelated accounts", async () => {
    const { store, config_path } = await fixture();
    const personal = account("personal", "VULTR_PERSONAL_TOKEN");
    await store.add(account("work"));
    await store.add(personal);
    await store.use("work");
    const renewed: Account = {
      id: "work",
      provider_id: "vultr",
      credentials: {
        api_key: { source: "literal", value: "renewed-local-credential" },
      },
    };
    expect(await store.save(renewed)).toEqual({
      version: 1,
      default_account_id: "work",
      accounts: [renewed, personal],
    });
    const saved = await new AccountStore(config_path).read();
    expect(resolveCredentials(resolveAccount(saved), {})).toEqual({
      api_key: "renewed-local-credential",
    });
    expect(saved.accounts).toEqual([renewed, personal]);
    expect((await stat(config_path)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(config_path, ".."))).toEqual(["config.json"]);
  });

  test("refuses to change an existing account's provider without altering configuration", async () => {
    const { store, config_path } = await fixture();
    await store.add(account("work"));
    await store.use("work");
    const original = await readFile(config_path, "utf8");
    await expect(
      store.save({ ...account("work"), provider_id: "another_provider" }),
    ).rejects.toMatchObject({ code: "conflict" });
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

  test("selects and removes unique provider shortcuts while persisting canonical IDs", async () => {
    const { store } = await fixture();
    const entry = account("vultr:user@example.com");
    const other = { ...account("gpu-work"), provider_id: "vast" };
    await store.add(entry);
    await store.add(other);
    expect(await store.use("vultr")).toEqual({
      version: 1,
      default_account_id: entry.id,
      accounts: [entry, other],
    });
    expect(await store.remove("vast")).toEqual({
      version: 1,
      default_account_id: entry.id,
      accounts: [entry],
    });
    expect(await store.remove("vultr")).toEqual({ version: 1, accounts: [] });
    expect(await store.read()).toEqual({ version: 1, accounts: [] });
  });

  test("updates shortcut ambiguity as accounts change without changing a saved default", async () => {
    const { store, config_path } = await fixture();
    const first = account("vultr:first@example.com");
    const second = account("vultr:second@example.com");
    await store.add(first);
    await store.use("vultr");
    await store.add(second);
    const original = await readFile(config_path, "utf8");
    expect(resolveAccount(await store.read())).toEqual(first);
    expect(() =>
      resolveAccount({ version: 1, accounts: [first, second] }, "vultr"),
    ).toThrow("ambiguous");
    await expect(store.use("vultr")).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(store.remove("vultr")).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(await readFile(config_path, "utf8")).toBe(original);
    await store.remove(second.id);
    expect(resolveAccount(await store.read(), "vultr")).toEqual(first);
    expect((await store.use("vultr")).default_account_id).toBe(first.id);
  });

  test("store mutations honor exact IDs instead of colliding provider shortcuts", async () => {
    const { store } = await fixture();
    const exact = account("vast");
    const provider_account = {
      ...account("vast:user@example.com"),
      provider_id: "vast",
    };
    await store.add(exact);
    await store.add(provider_account);
    expect((await store.use("vast")).default_account_id).toBe(exact.id);
    expect(await store.remove("vast")).toEqual({
      version: 1,
      accounts: [provider_account],
    });
    expect((await store.use("vast")).default_account_id).toBe(
      provider_account.id,
    );
  });

  test("rejects invalid account input and unsupported credential objects", async () => {
    const { store, config_path } = await fixture();
    const invalid_accounts: unknown[] = [
      { ...account("work"), id: "../work" },
      { ...account("work"), id: "a".repeat(65) },
      { ...account("work"), provider_id: "invalid/provider" },
      { ...account("work"), provider_id: "vultr:user@example.com" },
      { ...account("work"), provider_id: "v".repeat(65) },
      { ...account("vultr:user@example.com"), provider_id: "other_provider" },
      { ...account("vultr:user@example.com"), provider_id: "Vultr" },
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
      await expect(
        store.save(invalid_account as Account),
      ).rejects.toMatchObject({ code: "invalid_input" });
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
        accounts: [account("vultr:user@example.com")],
        default_account_id: "vultr:user@example.com\n",
      },
      {
        version: 1,
        accounts: [
          {
            ...account("vultr:user@example.com"),
            provider_id: "other_provider",
          },
        ],
      },
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
      await expect(store.save(account("new"))).rejects.toMatchObject({
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
    await expect(
      store.save(account("work", "RENEWED_TOKEN")),
    ).rejects.toMatchObject({
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
  test("resolves credential references before an account ID is known", () => {
    expect(
      resolveCredentialReferences(
        {
          api_key: { source: "literal", value: "  local-secret  " },
          api_secret: { source: "env", name: "PROVIDER_SECRET" },
        },
        { PROVIDER_SECRET: "env-secret" },
      ),
    ).toEqual({ api_key: "  local-secret  ", api_secret: "env-secret" });
    expect(() =>
      resolveCredentialReferences(
        { api_key: { source: "env", name: "PROVIDER_SECRET" } },
        {},
      ),
    ).toThrow("Missing credential environment variable: PROVIDER_SECRET.");
  });

  test("rejects malformed direct references with a secret-free error", () => {
    const malformed_references: unknown[] = [
      {},
      { api_key: { source: "literal", value: "   " } },
      {
        api_key: {
          source: "literal",
          value: "private-value",
          unexpected: true,
        },
      },
      { api_key: { source: "unsupported", value: "private-value" } },
      { api_key: { source: "env", name: "invalid-private-value" } },
    ];
    for (const credentials of malformed_references) {
      expect(() =>
        resolveCredentialReferences(credentials as Account["credentials"], {}),
      ).toThrow(
        new AppError("invalid_input", "Invalid credential configuration."),
      );
    }
  });

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

test("defaultConfigPath honors an explicit path", () => {
  expect(
    defaultConfigPath({
      VPSCTL_CONFIG: "/custom/accounts.json",
      XDG_CONFIG_HOME: "/xdg",
    }),
  ).toBe("/custom/accounts.json");
});

test("defaultConfigPath uses the tokn directory and ignores blank overrides", () => {
  for (const config_path of [undefined, "", "   "]) {
    expect(
      defaultConfigPath({
        VPSCTL_CONFIG: config_path,
        XDG_CONFIG_HOME: "/xdg",
      }),
    ).toMatch(/\/\.tokn\/vpsctl\/config\.json$/);
  }
});
