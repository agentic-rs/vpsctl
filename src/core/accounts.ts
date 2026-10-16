import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { AppError } from "./errors.ts";

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const account_email = z
  .email({ pattern: z.regexes.html5Email })
  .max(254)
  .refine((email) => {
    const local_part = email.slice(0, email.indexOf("@"));
    return (
      local_part.length <= 64 &&
      !local_part.startsWith(".") &&
      !local_part.endsWith(".") &&
      !local_part.includes("..") &&
      !email.includes("/")
    );
  });
const account_identifier = z
  .string()
  .max(319)
  .refine((id) => {
    if (identifier.safeParse(id).success) return true;
    const separator = id.indexOf(":");
    return (
      separator > 0 &&
      identifier.safeParse(id.slice(0, separator)).success &&
      account_email.safeParse(id.slice(separator + 1)).success
    );
  });
const credential_schema = z.discriminatedUnion("source", [
  z.strictObject({
    source: z.literal("env"),
    name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  }),
  z.strictObject({
    source: z.literal("literal"),
    value: z.string().refine((value) => value.trim().length > 0),
  }),
]);
const credentials_schema = z
  .record(z.string().min(1), credential_schema)
  .refine((credentials) => Object.keys(credentials).length > 0);
const account_schema = z
  .strictObject({
    id: account_identifier,
    provider_id: identifier,
    credentials: credentials_schema,
  })
  .refine(
    (account) =>
      !account.id.includes(":") ||
      account.id.startsWith(`${account.provider_id}:`),
    "Account ID provider must match its configured provider.",
  );
const config_schema = z
  .strictObject({
    version: z.literal(1),
    default_account_id: account_identifier.optional(),
    accounts: z.array(account_schema),
  })
  .superRefine((config, context) => {
    const ids = new Set<string>();
    for (const account of config.accounts) {
      if (ids.has(account.id)) {
        context.addIssue({ code: "custom", message: "Duplicate account ID." });
      }
      ids.add(account.id);
    }
    if (config.default_account_id && !ids.has(config.default_account_id)) {
      context.addIssue({ code: "custom", message: "Unknown default account." });
    }
  });

export type CredentialReference = z.infer<typeof credential_schema>;
export type Account = z.infer<typeof account_schema>;
export type AccountConfig = z.infer<typeof config_schema>;
export type AccountIdentity = Pick<Account, "id" | "provider_id">;

/** Use a provider shortcut only when it resolves back to this account. */
export function accountDisplayId(
  account: AccountIdentity,
  accounts: readonly AccountIdentity[],
): string {
  const provider_accounts = accounts.filter(
    (candidate) => candidate.provider_id === account.provider_id,
  );
  const collision = accounts.some(
    (candidate) =>
      candidate.id === account.provider_id && candidate.id !== account.id,
  );
  return provider_accounts.length === 1 &&
    provider_accounts[0]?.id === account.id &&
    !collision
    ? account.provider_id
    : account.id;
}

/** Exact IDs always take precedence over inferred provider shortcuts. */
export function findAccount(
  accounts: readonly Account[],
  selector: string,
): Account | undefined {
  const exact = accounts.find((account) => account.id === selector);
  if (exact) return exact;
  const candidates = accounts.filter(
    (account) => account.provider_id === selector,
  );
  if (candidates.length > 1) {
    throw new AppError(
      "invalid_input",
      "Account shortcut is ambiguous. Use a full account ID from auth list.",
    );
  }
  return candidates[0];
}

export function validateAccountId(id: string): string {
  if (!account_identifier.safeParse(id).success) {
    throw new AppError(
      "invalid_input",
      "Account IDs must be provider:email or 1–64 letters, digits, underscores, or hyphens, beginning with a letter or digit.",
    );
  }
  return id;
}

/** Derive an account ID from verified metadata, preserving the email's case. */
export function deriveAccountId(provider_id: string, email: string): string {
  if (!identifier.safeParse(provider_id).success) {
    throw new AppError("invalid_input", "Invalid provider ID.");
  }
  const verified_email = email.trim();
  if (!account_email.safeParse(verified_email).success) {
    throw new AppError(
      "invalid_input",
      "A valid account email is required to derive its account ID.",
    );
  }
  return `${provider_id}:${verified_email}`;
}

function parseAccount(value: unknown): Account {
  const result = account_schema.safeParse(value);
  if (!result.success) {
    throw new AppError("invalid_input", "Invalid account configuration.");
  }
  return result.data;
}

function parseConfig(value: unknown): AccountConfig {
  const result = config_schema.safeParse(value);
  if (!result.success) {
    throw new AppError("invalid_input", "Invalid account configuration file.");
  }
  return result.data;
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function configError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  return new AppError(
    "invalid_input",
    "Unable to access account configuration.",
  );
}

export function defaultConfigPath(
  env: Readonly<Record<string, string | undefined>>,
): string {
  if (env.VPSCTL_CONFIG?.trim()) return env.VPSCTL_CONFIG;
  return join(homedir(), ".tokn", "vpsctl", "config.json");
}

export function resolveAccount(
  config: AccountConfig,
  explicit_id?: string,
): Account {
  const validated_config = parseConfig(config);
  const account_id = explicit_id ?? validated_config.default_account_id;
  if (!account_id) {
    throw new AppError(
      "invalid_input",
      "Select an account with --account or set a default with auth use.",
    );
  }
  const account = findAccount(validated_config.accounts, account_id);
  if (!account) {
    throw new AppError("not_found", "Account not found.");
  }
  return account;
}

export function resolveCredentials(
  account: Account,
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const validated_account = parseAccount(account);
  return resolveCredentialReferences(validated_account.credentials, env);
}

export function resolveCredentialReferences(
  credentials: Account["credentials"],
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const validated_credentials = credentials_schema.safeParse(credentials);
  if (!validated_credentials.success) {
    throw new AppError("invalid_input", "Invalid credential configuration.");
  }
  const entries = Object.entries(validated_credentials.data).map(
    ([field, reference]) => {
      if (reference.source === "literal") return [field, reference.value];
      const value = Object.hasOwn(env, reference.name)
        ? env[reference.name]
        : undefined;
      if (typeof value !== "string" || !value.trim()) {
        throw new AppError(
          "authentication",
          `Missing credential environment variable: ${reference.name}.`,
        );
      }
      return [field, value];
    },
  );
  return Object.fromEntries(entries);
}

export class AccountStore {
  constructor(private readonly config_path: string) {}

  async read(): Promise<AccountConfig> {
    let contents: string;
    try {
      contents = await readFile(this.config_path, "utf8");
    } catch (error) {
      if (hasCode(error, "ENOENT")) return { version: 1, accounts: [] };
      throw configError(error);
    }
    let value: unknown;
    try {
      value = JSON.parse(contents);
    } catch {
      throw new AppError(
        "invalid_input",
        "Invalid account configuration file.",
      );
    }
    return parseConfig(value);
  }

  async add(account: Account): Promise<AccountConfig> {
    const validated_account = parseAccount(account);
    return this.update((config) => {
      if (config.accounts.some(({ id }) => id === validated_account.id)) {
        throw new AppError(
          "conflict",
          "An account with this ID already exists.",
        );
      }
      return { ...config, accounts: [...config.accounts, validated_account] };
    });
  }

  async save(account: Account): Promise<AccountConfig> {
    const validated_account = parseAccount(account);
    return this.update((config) => {
      const existing = config.accounts.find(
        ({ id }) => id === validated_account.id,
      );
      if (!existing) {
        return { ...config, accounts: [...config.accounts, validated_account] };
      }
      if (existing.provider_id !== validated_account.provider_id) {
        throw new AppError(
          "conflict",
          "An existing account's provider cannot be changed.",
        );
      }
      return {
        ...config,
        accounts: config.accounts.map((entry) =>
          entry.id === validated_account.id ? validated_account : entry,
        ),
      };
    });
  }

  async remove(id: string): Promise<AccountConfig> {
    return this.update((config) => {
      const account = resolveAccount(config, id);
      const updated: AccountConfig = {
        ...config,
        accounts: config.accounts.filter((entry) => entry.id !== account.id),
      };
      if (updated.default_account_id === account.id) {
        delete updated.default_account_id;
      }
      return updated;
    });
  }

  async use(id: string): Promise<AccountConfig> {
    return this.update((config) => {
      const account = resolveAccount(config, id);
      return { ...config, default_account_id: account.id };
    });
  }

  private async update(
    transform: (config: AccountConfig) => AccountConfig,
  ): Promise<AccountConfig> {
    const config_dir = dirname(this.config_path);
    const lock_path = `${this.config_path}.lock`;
    const temp_path = join(
      config_dir,
      `.${basename(this.config_path)}.${randomUUID()}.tmp`,
    );
    try {
      await mkdir(config_dir, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw configError(error);
    }
    let lock: Awaited<ReturnType<typeof open>>;
    try {
      lock = await open(lock_path, "wx", 0o600);
    } catch (error) {
      if (hasCode(error, "EEXIST")) {
        throw new AppError(
          "conflict",
          "Account configuration is locked by another writer.",
        );
      }
      throw configError(error);
    }
    let result: { config: AccountConfig } | { error: AppError };
    try {
      const config = parseConfig(transform(await this.read()));
      const temp_file = await open(temp_path, "wx", 0o600);
      try {
        await temp_file.writeFile(
          `${JSON.stringify(config, null, 2)}\n`,
          "utf8",
        );
        await temp_file.sync();
      } finally {
        await temp_file.close();
      }
      await rename(temp_path, this.config_path);
      result = { config };
    } catch (error) {
      result = { error: configError(error) };
    }
    const cleanup = await Promise.allSettled([
      lock.close(),
      unlink(temp_path).catch((error: unknown) => {
        if (!hasCode(error, "ENOENT")) throw error;
      }),
    ]);
    cleanup.push(...(await Promise.allSettled([unlink(lock_path)])));
    if ("error" in result) throw result.error;
    if (cleanup.some((operation) => operation.status === "rejected")) {
      throw new AppError(
        "invalid_input",
        "Unable to clean up account configuration write files.",
      );
    }
    return result.config;
  }
}
