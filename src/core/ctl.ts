import { isIP } from "node:net";
import { z } from "zod";
import { AppError } from "./errors.ts";
import { validateSshUser } from "./ssh.ts";

export interface CtlMethod {
  method_id: string;
  name: string;
  ssh_config_alias?: string | undefined;
  tailscale_node_id?: string | undefined;
  target: {
    kind: "ssh";
    destination: string;
    hostname?: string | undefined;
    user?: string | undefined;
    port?: number | undefined;
    identity_file?: string | undefined;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface CtlHost {
  host_id: string;
  name: string;
  connection_methods: CtlMethod[];
  preferred_method_id: string;
  [key: string]: unknown;
}

export interface CtlHostInput {
  name: string;
  destination: string;
  port: number;
  user?: string;
  identity_file?: string;
}

export interface CtlClient {
  listHosts(): Promise<CtlHost[]>;
  createHost(input: CtlHostInput): Promise<CtlHost>;
  updateHost(
    host_id: string,
    method_id: string,
    input: CtlHostInput,
  ): Promise<CtlHost>;
  connect(host_id: string, method_id: string): Promise<number>;
}

interface CtlProcessOptions {
  env: Readonly<Record<string, string | undefined>>;
  inherit_stdio: boolean;
}

export type CtlProcessRunner = (
  args: readonly string[],
  options: CtlProcessOptions,
) => Promise<{ exit_code: number; stdout: string }>;

const safe_id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/);
const safe_text = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => value.trim() === value && !/[\p{Cc}\p{Cf}]/u.test(value));
const safe_argument = safe_text.refine((value) => !value.startsWith("-"));
const safe_user = z.string().refine((value) => {
  try {
    validateSshUser(value);
    return true;
  } catch {
    return false;
  }
});
const port_schema = z.number().int().min(1).max(65535);

const target_schema = z.looseObject({
  kind: z.literal("ssh"),
  destination: safe_text,
  hostname: safe_text.optional(),
  user: safe_text.optional(),
  port: port_schema.optional(),
  identity_file: safe_text.optional(),
});
const method_schema = z.looseObject({
  method_id: safe_id,
  name: safe_text,
  ssh_config_alias: safe_text.optional(),
  tailscale_node_id: safe_text.optional(),
  target: target_schema,
});
const host_schema = z
  .looseObject({
    host_id: safe_id,
    name: safe_text,
    connection_methods: z.array(method_schema).min(1),
    preferred_method_id: safe_id,
  })
  .refine(
    (host) =>
      new Set(host.connection_methods.map((method) => method.method_id))
        .size === host.connection_methods.length &&
      host.connection_methods.some(
        (method) => method.method_id === host.preferred_method_id,
      ),
  );
const list_schema = z
  .array(z.object({ host: host_schema }))
  .refine(
    (entries) =>
      new Set(entries.map((entry) => entry.host.host_id)).size ===
      entries.length,
  );
const input_schema = z.strictObject({
  name: safe_argument,
  destination: safe_argument.refine(isDestination),
  port: port_schema,
  user: safe_user.optional(),
  identity_file: safe_argument.optional(),
});

function isDestination(value: string): boolean {
  if (value.includes("%")) return false;
  if (isIP(value) !== 0) return true;
  if (value.startsWith("[") && value.endsWith("]")) {
    return isIP(value.slice(1, -1)) === 6;
  }
  return (
    value.length <= 253 &&
    value
      .replace(/\.$/, "")
      .split(".")
      .every((label) =>
        /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label),
      )
  );
}

function validateInput(input: CtlHostInput): CtlHostInput {
  if (!input_schema.safeParse(input).success) {
    throw new AppError(
      "invalid_input",
      "Invalid ctl host connection settings.",
    );
  }
  return input;
}

function validateIds(host_id: string, method_id: string): void {
  if (
    !safe_id.safeParse(host_id).success ||
    !safe_id.safeParse(method_id).success
  ) {
    throw new AppError(
      "invalid_input",
      "Invalid ctl host or connection method ID.",
    );
  }
}

function parseJson<T>(output: string, schema: z.ZodType<T>): T {
  try {
    if (output.length > 8 * 1024 * 1024)
      throw new Error("Oversized ctl response.");
    const result = schema.safeParse(JSON.parse(output));
    if (result.success) return result.data;
  } catch {
    // Catalog output may contain private settings; never include it in errors.
  }
  throw new AppError(
    "invalid_response",
    "ctl returned an invalid saved-host response. Check the installed ctl version.",
  );
}

async function runProcess(
  args: readonly string[],
  options: CtlProcessOptions,
): Promise<{ exit_code: number; stdout: string }> {
  if (options.inherit_stdio) {
    const process = Bun.spawn(["ctl", ...args], {
      env: { ...options.env },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    return { exit_code: await process.exited, stdout: "" };
  }
  const process = Bun.spawn(["ctl", ...args], {
    env: { ...options.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const stdout = new Response(process.stdout).text();
  const [output, exit_code] = await Promise.all([stdout, process.exited]);
  return { exit_code, stdout: output };
}

export function createCtlClient(
  env: Readonly<Record<string, string | undefined>>,
  runner: CtlProcessRunner = runProcess,
): CtlClient {
  const run = async (
    args: string[],
    operation: string,
    inherit_stdio = false,
  ): Promise<{ exit_code: number; stdout: string }> => {
    let result: { exit_code: number; stdout: string };
    try {
      result = await runner(args, { env, inherit_stdio });
    } catch (error) {
      const code =
        error !== null && typeof error === "object" && "code" in error
          ? error.code
          : undefined;
      if (code === "ENOENT") {
        throw new AppError(
          "not_found",
          "ctl was not found. Install ctl and make it available on PATH, then retry instance login.",
        );
      }
      throw new AppError(
        "provider_error",
        `Could not run ctl to ${operation}. Check that ctl is installed and executable.`,
      );
    }
    if (!inherit_stdio && result.exit_code !== 0) {
      throw new AppError(
        "provider_error",
        `ctl could not ${operation} (exit ${result.exit_code}). Check ctl's saved-host configuration and permissions.`,
      );
    }
    return result;
  };
  const connectionArgs = (input: CtlHostInput): string[] => [
    "--port",
    String(input.port),
    ...(input.user === undefined ? [] : ["--user", input.user]),
    ...(input.identity_file === undefined
      ? []
      : ["--identity-file", input.identity_file]),
  ];

  return {
    async listHosts() {
      const result = await run(["host", "list", "--json"], "list saved hosts");
      return parseJson(result.stdout, list_schema).map((entry) => entry.host);
    },
    async createHost(input) {
      validateInput(input);
      const result = await run(
        [
          "host",
          "create",
          input.name,
          input.destination,
          "--method-name",
          "vpsctl",
          ...connectionArgs(input),
          "--json",
        ],
        "create the saved host",
      );
      return parseJson(result.stdout, host_schema);
    },
    async updateHost(host_id, method_id, input) {
      validateIds(host_id, method_id);
      validateInput(input);
      const result = await run(
        [
          "host",
          "update",
          host_id,
          "--method",
          method_id,
          "--name",
          input.name,
          "--destination",
          input.destination,
          ...connectionArgs(input),
          "--json",
        ],
        "update the saved host",
      );
      const host = parseJson(result.stdout, host_schema);
      if (
        host.host_id !== host_id ||
        !host.connection_methods.some(
          (method) => method.method_id === method_id,
        )
      ) {
        throw new AppError(
          "invalid_response",
          "ctl returned a different saved host or connection method after updating it.",
        );
      }
      return host;
    },
    async connect(host_id, method_id) {
      validateIds(host_id, method_id);
      const result = await run(
        ["--method", method_id, "ssh", host_id],
        "connect to the saved host",
        true,
      );
      return result.exit_code;
    },
  };
}
