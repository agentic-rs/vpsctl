import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, isIP, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AppError } from "./errors.ts";
import { validateSshUser } from "./ssh.ts";

interface PasswordConnection {
  host: string;
  port: number;
  user: string;
}

const helper_argument = "--internal-ssh-askpass";
const maximum_password_bytes = 4096;
const maximum_request_bytes = 16 * 1024;
const request_timeout_ms = 5000;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function helperCommand(): string[] {
  // Compiled Bun programs execute their embedded entry point directly. In
  // development use this repository's CLI, including when called from tests.
  return Bun.main.startsWith("/$bunfs/")
    ? [process.execPath, helper_argument]
    : [
        process.execPath,
        fileURLToPath(new URL("../cli.ts", import.meta.url)),
        helper_argument,
      ];
}

function validateConnection(connection: PasswordConnection): void {
  validateSshUser(connection.user);
  const host = connection.host;
  const valid_hostname =
    host.length <= 253 &&
    host
      .replace(/\.$/, "")
      .split(".")
      .every((label) =>
        /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label),
      );
  if (
    (isIP(host) === 0 && !valid_hostname) ||
    host.includes("%") ||
    !Number.isInteger(connection.port) ||
    connection.port < 1 ||
    connection.port > 65535
  ) {
    throw new AppError(
      "invalid_input",
      "Invalid password SSH connection settings.",
    );
  }
}

function passwordPrompts(connection: PasswordConnection): Set<string> {
  const host = connection.host.toLowerCase();
  // Older OpenSSH versions truncate the host in this locally generated prompt.
  return new Set(
    [host, host.slice(0, 100)].map(
      (value) => `${connection.user}@${value}'s password:`,
    ),
  );
}

function isHostConfirmation(prompt: string): boolean {
  return (
    prompt.endsWith(
      "Are you sure you want to continue connecting (yes/no/[fingerprint])?",
    ) ||
    prompt.endsWith("Are you sure you want to continue connecting (yes/no)?")
  );
}

interface AskpassRequest {
  token: string;
  prompt: string;
  is_confirm: boolean;
}

function parseRequest(data: Buffer, token: Buffer): AskpassRequest | undefined {
  try {
    const request: unknown = JSON.parse(data.toString("utf8"));
    if (request === null || typeof request !== "object") return;
    const fields = Object.keys(request);
    if (
      fields.length !== 3 ||
      !("token" in request) ||
      typeof request.token !== "string" ||
      !/^[a-f0-9]{64}$/.test(request.token) ||
      !("prompt" in request) ||
      typeof request.prompt !== "string" ||
      request.prompt.length > 8192 ||
      !("is_confirm" in request) ||
      typeof request.is_confirm !== "boolean"
    ) {
      return;
    }
    const supplied_token = Buffer.from(request.token, "hex");
    if (!timingSafeEqual(supplied_token, token)) return;
    return request as AskpassRequest;
  } catch {
    return;
  }
}

async function removeHelper(directory: string): Promise<void> {
  try {
    await rm(directory, { recursive: true, force: true });
  } catch {
    throw new AppError(
      "provider_error",
      "Could not remove the temporary SSH password helper.",
    );
  }
}

export function validateSshPassword(password: unknown): string {
  if (
    typeof password !== "string" ||
    password.length === 0 ||
    Buffer.byteLength(password) > maximum_password_bytes ||
    /[\p{Cc}\p{Cf}]/u.test(password)
  ) {
    throw new AppError(
      "invalid_response",
      "The provider returned an invalid SSH password.",
    );
  }
  return password;
}

/** Supply one provider password to the selected OpenSSH endpoint, in memory. */
export async function withSshPassword(
  connection: PasswordConnection,
  password: string,
  execute: (env: Record<string, string>) => Promise<number>,
): Promise<number> {
  if (process.platform === "win32") {
    throw new AppError(
      "unsupported_operation",
      "Provider password login currently requires a Unix terminal.",
    );
  }
  validateConnection(connection);
  password = validateSshPassword(password);
  const secret = Buffer.from(password);
  password = "";
  const token = randomBytes(32);
  const prompts = passwordPrompts(connection);
  const sockets = new Set<Socket>();
  const responses = new Set<Buffer>();
  let consumed = false;
  let directory: string | undefined;
  const server = createServer((socket) => {
    sockets.add(socket);
    let data = Buffer.alloc(0);
    let answered = false;
    socket.setTimeout(request_timeout_ms, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      data.fill(0);
      sockets.delete(socket);
    });
    socket.on("data", (chunk: Buffer) => {
      if (answered || data.length + chunk.length > maximum_request_bytes) {
        socket.destroy();
        return;
      }
      data = Buffer.concat([data, chunk]);
      if (data.indexOf(10) < 0) return;
      answered = true;
      const request = parseRequest(data, token);
      if (!request) {
        socket.end("N\n");
        return;
      }
      const prompt = request.prompt.trimEnd();
      if (isHostConfirmation(prompt)) {
        // Trust decisions belong to the user; this reply carries no secret.
        socket.end("T\n");
        return;
      }
      if (request.is_confirm || consumed || !prompts.has(prompt)) {
        socket.end("N\n");
        return;
      }
      consumed = true;
      const response = Buffer.concat([
        Buffer.from("P"),
        secret,
        Buffer.from("\n"),
      ]);
      responses.add(response);
      secret.fill(0);
      socket.end(response, () => {
        response.fill(0);
        responses.delete(response);
      });
    });
  });
  try {
    directory = await mkdtemp(join(tmpdir(), "vpsctl-ssh-"));
    await chmod(directory, 0o700);
    const socket_path = join(directory, "s");
    const helper_path = join(directory, "askpass");
    await writeFile(
      helper_path,
      `#!/bin/sh\nexec ${helperCommand().map(shellQuote).join(" ")} "$@"\n`,
      { mode: 0o700, flag: "wx" },
    );
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket_path, () => {
        server.off("error", reject);
        resolve();
      });
    });
    await chmod(socket_path, 0o600);
    return await execute({
      SSH_ASKPASS: helper_path,
      SSH_ASKPASS_REQUIRE: "force",
      VPSCTL_ASKPASS_SOCKET: socket_path,
      VPSCTL_ASKPASS_TOKEN: token.toString("hex"),
      LC_ALL: "C",
      LANG: "C",
    });
  } catch (error) {
    throw new AppError(
      error instanceof AppError ? error.code : "provider_error",
      "Could not complete the password-authenticated SSH connection.",
    );
  } finally {
    secret.fill(0);
    token.fill(0);
    for (const response of responses) response.fill(0);
    for (const socket of sockets) socket.destroy();
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (directory !== undefined) await removeHelper(directory);
  }
}

async function validateSocket(socket_path: string): Promise<void> {
  if (!isAbsolute(socket_path)) throw new Error("Invalid askpass socket.");
  const [directory, socket] = await Promise.all([
    lstat(dirname(socket_path)),
    lstat(socket_path),
  ]);
  const uid = process.getuid?.();
  if (
    uid === undefined ||
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    directory.uid !== uid ||
    (directory.mode & 0o777) !== 0o700 ||
    !socket.isSocket() ||
    socket.isSymbolicLink() ||
    socket.uid !== uid ||
    (socket.mode & 0o777) !== 0o600
  ) {
    throw new Error("Invalid askpass socket.");
  }
}

async function requestPassword(
  socket_path: string,
  request: AskpassRequest,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socket_path);
    let response = Buffer.alloc(0);
    const fail = () => {
      response.fill(0);
      socket.destroy();
      reject(new Error("SSH password request failed."));
    };
    socket.setTimeout(request_timeout_ms, fail);
    socket.on("error", fail);
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: Buffer) => {
      if (response.length + chunk.length > maximum_password_bytes + 2) {
        fail();
        return;
      }
      const previous = response;
      response = Buffer.concat([response, chunk]);
      previous.fill(0);
    });
    socket.on("end", () => {
      socket.destroy();
      resolve(response);
    });
  });
}

async function confirmHost(prompt: string): Promise<Buffer> {
  const terminal = await open("/dev/tty", "r+");
  const input = Buffer.alloc(1024);
  try {
    const message = prompt.replace(/[\p{Cc}\p{Cf}]/gu, (character) =>
      character === "\n" || character === "\t" ? character : "",
    );
    await terminal.write(`${message.trimEnd()} `);
    let length = 0;
    while (length < input.length) {
      const { bytesRead } = await terminal.read(input, length, 1, null);
      if (bytesRead === 0) throw new Error("Host confirmation cancelled.");
      length += bytesRead;
      if (input[length - 1] === 10)
        return Buffer.from(input.subarray(0, length));
    }
    throw new Error("Host confirmation cancelled.");
  } finally {
    input.fill(0);
    await terminal.close();
  }
}

/** Private OpenSSH helper. It deliberately emits neither diagnostics nor CLI output. */
export async function runSshPasswordHelper(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<number | undefined> {
  if (args[0] !== helper_argument) return;
  let response: Buffer | undefined;
  let output: Buffer | undefined;
  try {
    const prompt = args[1];
    const socket_path = env.VPSCTL_ASKPASS_SOCKET;
    const token = env.VPSCTL_ASKPASS_TOKEN;
    if (
      process.platform === "win32" ||
      args.length !== 2 ||
      prompt === undefined ||
      prompt.length > 8192 ||
      socket_path === undefined ||
      token === undefined ||
      !/^[a-f0-9]{64}$/.test(token)
    ) {
      return 1;
    }
    await validateSocket(socket_path);
    response = await requestPassword(socket_path, {
      token,
      prompt,
      is_confirm: env.SSH_ASKPASS_PROMPT === "confirm",
    });
    if (response.equals(Buffer.from("T\n"))) {
      output = await confirmHost(prompt);
    } else if (
      response[0] === 80 &&
      response.length > 2 &&
      response[response.length - 1] === 10
    ) {
      output = response.subarray(1);
    } else {
      return 1;
    }
    const bytes = output;
    await new Promise<void>((resolve, reject) =>
      process.stdout.write(bytes, (error) =>
        error ? reject(error) : resolve(),
      ),
    );
    return 0;
  } catch {
    return 1;
  } finally {
    output?.fill(0);
    response?.fill(0);
  }
}
