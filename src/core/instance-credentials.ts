import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { AppError } from "./errors.ts";
import type { InstanceLoginCredential } from "./provider.ts";
import { validateSshUser } from "./ssh.ts";
import { validateSshPassword } from "./ssh-password.ts";

export interface InstanceCredentialKey {
  provider_id: string;
  account_id: string;
  instance_id: string;
}

const maximum_file_bytes = 8 * 1024 * 1024;
const credential_schema = z.strictObject({
  user: z.string().optional(),
  password: z.string(),
});
const store_schema = z.strictObject({
  version: z.literal(1),
  credentials: z.record(z.string().regex(/^[a-f0-9]{64}$/), credential_schema),
});
type CredentialFile = z.infer<typeof store_schema>;
type FileHandle = Awaited<ReturnType<typeof open>>;

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function storeError(): AppError {
  return new AppError(
    "invalid_input",
    "Unable to access saved instance credentials securely.",
  );
}

function invalidFile(): AppError {
  return new AppError("invalid_input", "Invalid saved instance credentials.");
}

function validateCredential(value: unknown): InstanceLoginCredential {
  try {
    const parsed = credential_schema.parse(value);
    const password = validateSshPassword(parsed.password);
    return parsed.user === undefined
      ? { password }
      : { user: validateSshUser(parsed.user), password };
  } catch {
    throw invalidFile();
  }
}

function keyHash(key: InstanceCredentialKey): string {
  const fields = [key.provider_id, key.account_id, key.instance_id];
  if (
    fields.some(
      (value) =>
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > 4096 ||
        /[\p{Cc}\p{Cf}]/u.test(value),
    )
  ) {
    throw new AppError(
      "invalid_input",
      "Invalid instance credential reference.",
    );
  }
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

function isOwnerOnly(info: Stats): boolean {
  return (
    (process.getuid === undefined || info.uid === process.getuid()) &&
    (info.mode & 0o077) === 0
  );
}

function validateFile(info: Stats): void {
  if (
    !info.isFile() ||
    !isOwnerOnly(info) ||
    info.nlink !== 1 ||
    info.size > maximum_file_bytes
  ) {
    throw storeError();
  }
}

async function directoryExists(path: string): Promise<boolean> {
  let info: Stats;
  try {
    info = await lstat(path);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw storeError();
  }
  if (!info.isDirectory() || !isOwnerOnly(info)) throw storeError();
  return true;
}

async function existingFile(path: string): Promise<Stats | undefined> {
  try {
    const info = await lstat(path);
    validateFile(info);
    return info;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw storeError();
  }
}

function parseContents(contents: string): CredentialFile {
  if (contents.trim().length === 0) return { version: 1, credentials: {} };
  try {
    const parsed = store_schema.parse(JSON.parse(contents));
    for (const value of Object.values(parsed.credentials)) {
      validateCredential(value);
    }
    return parsed;
  } catch {
    throw invalidFile();
  }
}

/** Use a separate local file, isolated from other configuration files. */
export function instanceCredentialPath(config_path: string): string {
  return `${config_path}.instance-credentials.local.json`;
}

/** Store passwords locally without persisting provider, account, or instance IDs. */
export class InstanceCredentialStore {
  constructor(private readonly path: string) {}

  async get(
    key: InstanceCredentialKey,
  ): Promise<InstanceLoginCredential | undefined> {
    const hash = keyHash(key);
    const value = (await this.read()).credentials[hash];
    return value === undefined ? undefined : validateCredential(value);
  }

  async set(
    key: InstanceCredentialKey,
    credential: InstanceLoginCredential,
  ): Promise<void> {
    const hash = keyHash(key);
    const validated = validateCredential(credential);
    await this.update((file) => {
      file.credentials[hash] = validated;
      return true;
    });
  }

  async remove(key: InstanceCredentialKey): Promise<void> {
    const hash = keyHash(key);
    await this.update((file) => {
      if (!Object.hasOwn(file.credentials, hash)) return false;
      delete file.credentials[hash];
      return true;
    }, false);
  }

  private async read(): Promise<CredentialFile> {
    try {
      if (!(await directoryExists(dirname(this.path)))) {
        return { version: 1, credentials: {} };
      }
      const info = await existingFile(this.path);
      if (info === undefined) return { version: 1, credentials: {} };
      const file = await open(
        this.path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const opened_info = await file.stat();
        validateFile(opened_info);
        if (opened_info.ino !== info.ino || opened_info.dev !== info.dev) {
          throw storeError();
        }
        return parseContents(await file.readFile("utf8"));
      } finally {
        await file.close();
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw storeError();
    }
  }

  private async acquireLock(path: string): Promise<FileHandle> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        const file = await open(
          path,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
        try {
          validateFile(await file.stat());
        } catch (error) {
          await file.close();
          await unlink(path);
          throw error;
        }
        return file;
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw storeError();
        await existingFile(path);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    throw new AppError(
      "conflict",
      "Saved instance credentials are locked by another writer. Retry shortly.",
    );
  }

  private async update(
    transform: (file: CredentialFile) => boolean,
    create_directory = true,
  ): Promise<void> {
    const directory = dirname(this.path);
    let lock: FileHandle | undefined;
    let temp_path: string | undefined;
    const lock_path = `${this.path}.lock`;
    let result_error: unknown;
    try {
      if (create_directory) {
        await mkdir(directory, { recursive: true, mode: 0o700 });
      }
      if (await directoryExists(directory)) {
        lock = await this.acquireLock(lock_path);
        const file = await this.read();
        if (transform(file)) {
          const contents = `${JSON.stringify(file, null, 2)}\n`;
          if (Buffer.byteLength(contents) > maximum_file_bytes)
            throw invalidFile();
          temp_path = join(
            directory,
            `.${basename(this.path)}.${randomUUID()}.tmp`,
          );
          const temporary = await open(
            temp_path,
            constants.O_WRONLY |
              constants.O_CREAT |
              constants.O_EXCL |
              constants.O_NOFOLLOW,
            0o600,
          );
          try {
            validateFile(await temporary.stat());
            await temporary.writeFile(contents, "utf8");
            await temporary.sync();
          } finally {
            await temporary.close();
          }
          await directoryExists(directory);
          await existingFile(this.path);
          await rename(temp_path, this.path);
          temp_path = undefined;
        }
      }
    } catch (error) {
      result_error = error instanceof AppError ? error : storeError();
    }
    const cleanup = await Promise.allSettled([
      ...(temp_path === undefined
        ? []
        : [
            unlink(temp_path).catch((error: unknown) => {
              if (!hasCode(error, "ENOENT")) throw error;
            }),
          ]),
      ...(lock === undefined ? [] : [lock.close()]),
    ]);
    if (lock !== undefined) {
      cleanup.push(...(await Promise.allSettled([unlink(lock_path)])));
    }
    if (result_error !== undefined) throw result_error;
    if (cleanup.some((operation) => operation.status === "rejected")) {
      throw storeError();
    }
  }
}
