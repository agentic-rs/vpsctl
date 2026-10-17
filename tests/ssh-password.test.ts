import { describe, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AppError } from "../src/core/errors.ts";
import {
  runSshPasswordHelper,
  validateSshPassword,
  withSshPassword,
} from "../src/core/ssh-password.ts";

const connection = { host: "203.0.113.10", port: 2222, user: "root" };
const password = "synthetic-private-password-'$`tail";
const prompt = "root@203.0.113.10's password: ";

async function invokeHelper(
  env: Record<string, string>,
  message = prompt,
  overrides: Record<string, string> = {},
) {
  const helper = env.SSH_ASKPASS;
  if (helper === undefined) throw new Error("Missing test helper.");
  const child = Bun.spawn([helper, message], {
    env: { ...process.env, ...env, ...overrides },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit_code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exit_code };
}

async function rawRequest(
  env: Record<string, string>,
  data: string,
): Promise<string> {
  const path = env.VPSCTL_ASKPASS_SOCKET;
  if (path === undefined) throw new Error("Missing test socket.");
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let output = "";
    socket.on("connect", () => socket.write(data));
    socket.on("data", (chunk) => {
      output += chunk.toString();
    });
    socket.on("end", () => {
      socket.destroy();
      resolve(output);
    });
    socket.on("error", reject);
  });
}

async function expectRemoved(path: string): Promise<void> {
  try {
    await stat(path);
  } catch (error) {
    expect(error).toHaveProperty("code", "ENOENT");
    return;
  }
  throw new Error("Temporary SSH helper survived cleanup.");
}

describe("one-connection SSH password relay", () => {
  test("relays a provider password only through the helper stdout pipe and removes its files", async () => {
    let helper_directory = "";
    const exit_code = await withSshPassword(
      connection,
      password,
      async (env) => {
        helper_directory = dirname(env.SSH_ASKPASS ?? "");
        expect(env.SSH_ASKPASS_REQUIRE).toBe("force");
        expect(env.LC_ALL).toBe("C");
        expect(env.LANG).toBe("C");
        expect(JSON.stringify(env)).not.toContain(password);
        expect((await lstat(helper_directory)).mode & 0o777).toBe(0o700);
        expect(
          (await lstat(env.VPSCTL_ASKPASS_SOCKET ?? "")).mode & 0o777,
        ).toBe(0o600);
        const files = await readdir(helper_directory, { withFileTypes: true });
        expect(files.map((file) => file.name).sort()).toEqual(["askpass", "s"]);
        for (const file of files.filter((entry) => entry.isFile())) {
          expect(
            await readFile(join(helper_directory, file.name), "utf8"),
          ).not.toContain(password);
        }
        const result = await invokeHelper(env);
        expect(result).toEqual({
          stdout: `${password}\n`,
          stderr: "",
          exit_code: 0,
        });
        expect(await invokeHelper(env)).toEqual({
          stdout: "",
          stderr: "",
          exit_code: 1,
        });
        return 37;
      },
    );
    expect(exit_code).toBe(37);
    await expectRemoved(helper_directory);
  });

  test.each([
    "password:",
    "Password:",
    "other@203.0.113.10's password: ",
    "root@203.0.113.11's password: ",
    "root@gateway.example.invalid's password: ",
    "Enter passphrase for key 'example-key': ",
    "Enter root@203.0.113.10's old password: ",
    "Enter root@203.0.113.10's new password: ",
    "Verification code: ",
    "root@203.0.113.10's password: extra",
    "\u001b[31mroot@203.0.113.10's password: ",
  ])(
    "refuses unrelated or remote-controlled prompt %j without consuming the password",
    async (message) => {
      await withSshPassword(connection, password, async (env) => {
        expect(await invokeHelper(env, message)).toEqual({
          stdout: "",
          stderr: "",
          exit_code: 1,
        });
        expect((await invokeHelper(env)).stdout).toBe(`${password}\n`);
        return 0;
      });
    },
  );

  test("never treats a confirmation request as a password prompt", async () => {
    await withSshPassword(connection, password, async (env) => {
      expect(
        await invokeHelper(env, prompt, { SSH_ASKPASS_PROMPT: "confirm" }),
      ).toEqual({ stdout: "", stderr: "", exit_code: 1 });
      expect((await invokeHelper(env)).stdout).toBe(`${password}\n`);
      return 0;
    });
  });

  test.each([
    {
      host: "SERVER.Example.Invalid",
      prompt: "root@server.example.invalid's password: ",
    },
    { host: "2001:db8::10", prompt: "root@2001:db8::10's password: " },
    {
      host: `${"a".repeat(60)}.${"b".repeat(60)}.example.invalid`,
      prompt: `root@${`${"a".repeat(60)}.${"b".repeat(60)}.example.invalid`.slice(0, 100)}'s password: `,
    },
  ])(
    "supports the locally generated OpenSSH host spelling $host",
    async (entry) => {
      await withSshPassword(
        { ...connection, host: entry.host },
        password,
        async (env) => {
          expect((await invokeHelper(env, entry.prompt)).stdout).toBe(
            `${password}\n`,
          );
          return 0;
        },
      );
    },
  );

  test("authenticates socket requests and rejects malformed or unknown fields", async () => {
    await withSshPassword(connection, password, async (env) => {
      const valid = {
        token: env.VPSCTL_ASKPASS_TOKEN,
        prompt,
        is_confirm: false,
      };
      for (const request of [
        { ...valid, token: "0".repeat(64) },
        { ...valid, extra: "ignored-field" },
        { ...valid, is_confirm: "false" },
        { ...valid, prompt: "x".repeat(8193) },
        [],
        null,
      ]) {
        expect(await rawRequest(env, `${JSON.stringify(request)}\n`)).toBe(
          "N\n",
        );
      }
      expect(await rawRequest(env, "not-json\n")).toBe("N\n");
      expect((await invokeHelper(env)).stdout).toBe(`${password}\n`);
      return 0;
    });
  });

  test("routes host-key decisions to a separate terminal channel without consuming the password", async () => {
    await withSshPassword(connection, password, async (env) => {
      for (const ending of ["(yes/no/[fingerprint])?", "(yes/no)?"]) {
        const response = await rawRequest(
          env,
          `${JSON.stringify({
            token: env.VPSCTL_ASKPASS_TOKEN,
            prompt: `Host key details\nAre you sure you want to continue connecting ${ending} `,
            is_confirm: true,
          })}\n`,
        );
        expect(response).toBe("T\n");
        expect(response).not.toContain(password);
      }
      expect((await invokeHelper(env)).stdout).toBe(`${password}\n`);
      return 0;
    });
  });

  test("refuses a socket whose permissions were broadened", async () => {
    await withSshPassword(connection, password, async (env) => {
      const socket_path = env.VPSCTL_ASKPASS_SOCKET ?? "";
      await chmod(socket_path, 0o644);
      expect(await invokeHelper(env)).toEqual({
        stdout: "",
        stderr: "",
        exit_code: 1,
      });
      await chmod(socket_path, 0o600);
      expect((await invokeHelper(env)).stdout).toBe(`${password}\n`);
      return 0;
    });
  });

  test("cleans up and curates callback failures that could contain secret text", async () => {
    let helper_directory = "";
    try {
      await withSshPassword(connection, password, async (env) => {
        helper_directory = dirname(env.SSH_ASKPASS ?? "");
        throw new Error(password);
      });
      throw new Error("Expected a synthetic failure.");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect(String(error)).not.toContain(password);
    }
    await expectRemoved(helper_directory);
  });

  test.each([
    "",
    "line\nfeed",
    "line\rreturn",
    "nul\0byte",
    "hidden\u200bseparator",
    "a".repeat(4097),
    "界".repeat(2000),
  ])("rejects invalid passwords before execution", async (value) => {
    let called = false;
    await expect(
      withSshPassword(connection, value, async () => {
        called = true;
        return 0;
      }),
    ).rejects.toMatchObject({ code: "invalid_response" });
    expect(called).toBe(false);
  });

  test.each(
    [
      undefined,
      null,
      123,
      {},
      [],
      "a".repeat(4097),
      "界".repeat(2000),
      "hidden\u200bseparator",
    ].map((value) => [value]),
  )(
    "rejects malformed provider passwords during shared preflight validation",
    (value) => {
      expect(() => validateSshPassword(value)).toThrow(AppError);
    },
  );

  test("validates the byte limit without rejecting valid Unicode passwords", () => {
    expect(validateSshPassword("界".repeat(1365))).toBe("界".repeat(1365));
    expect(validateSshPassword("a".repeat(4096))).toBe("a".repeat(4096));
  });

  test("internal helper mode fails closed without an active owned socket", async () => {
    expect(await runSshPasswordHelper(["--version"], {})).toBeUndefined();
    expect(
      await runSshPasswordHelper(["--internal-ssh-askpass", prompt], {}),
    ).toBe(1);
    expect(await runSshPasswordHelper(["--internal-ssh-askpass"], {})).toBe(1);
  });

  test("compiled programs invoke their own private helper entry point", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vpsctl-compiled-askpass-"));
    try {
      const module_path = fileURLToPath(
        new URL("../src/core/ssh-password.ts", import.meta.url),
      );
      const source = join(directory, "harness.ts");
      const binary = join(directory, "harness");
      await writeFile(
        source,
        `
import { runSshPasswordHelper, withSshPassword } from ${JSON.stringify(module_path)};
const helper_exit = await runSshPasswordHelper(Bun.argv.slice(2));
if (helper_exit !== undefined) {
  process.exitCode = helper_exit;
} else {
  process.exitCode = await withSshPassword(
    { host: "203.0.113.10", port: 2222, user: "root" },
    "synthetic-compiled-password",
    async (env) => {
      const child = Bun.spawn([env.SSH_ASKPASS, "root@203.0.113.10's password: "], {
        env: { ...process.env, ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      const text = await new Response(child.stdout).text();
      const error = await new Response(child.stderr).text();
      const status = await child.exited;
      return text === "synthetic-compiled-password\\n" && error === "" && status === 0 ? 0 : 1;
    },
  );
}
`,
      );
      const build = Bun.spawn(
        [process.execPath, "build", source, "--compile", "--outfile", binary],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [build_out, build_err, build_exit] = await Promise.all([
        new Response(build.stdout).text(),
        new Response(build.stderr).text(),
        build.exited,
      ]);
      expect({ build_out, build_err, build_exit }).toMatchObject({
        build_exit: 0,
      });
      const run = Bun.spawn([binary], { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exit_code] = await Promise.all([
        new Response(run.stdout).text(),
        new Response(run.stderr).text(),
        run.exited,
      ]);
      expect({ stdout, stderr, exit_code }).toEqual({
        stdout: "",
        stderr: "",
        exit_code: 0,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 15000);
});
