import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CtlHost,
  type CtlHostInput,
  type CtlPasswordAuthentication,
  type CtlProcessRunner,
  createCtlClient,
} from "../src/core/ctl.ts";
import { AppError } from "../src/core/errors.ts";

const host: CtlHost = {
  host_id: "example-host-id",
  name: "example-host",
  connection_methods: [
    {
      method_id: "example-method-id",
      name: "vpsctl",
      target: {
        kind: "ssh",
        destination: "server.example.invalid",
        user: "example-user",
        port: 2222,
      },
    },
  ],
  preferred_method_id: "example-method-id",
};

const input: CtlHostInput = {
  name: "example-host",
  destination: "server.example.invalid",
  port: 2222,
  user: "example-user",
  identity_file: "example keys/private-key",
};

const password_authentication: CtlPasswordAuthentication = {
  user: "example-user",
  host: "server.example.invalid",
  port: 2222,
  password: "synthetic-instance-password",
};

function harness(responses: { exit_code: number; stdout: string }[] = []) {
  const calls: {
    args: readonly string[];
    options: Parameters<CtlProcessRunner>[1];
  }[] = [];
  const env = { PATH: "example-path", CTL_HOSTS_PATH: "example-catalog.json" };
  const client = createCtlClient(env, async (args, options) => {
    calls.push({ args, options });
    return responses.shift() ?? { exit_code: 0, stdout: JSON.stringify(host) };
  });
  return { client, calls, env };
}

async function errorFrom(operation: Promise<unknown>): Promise<AppError> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error("Expected a ctl error.");
}

describe("ctl saved-host client", () => {
  test("reads native list wrappers while preserving unrelated route settings", async () => {
    const saved = structuredClone(host);
    const method = saved.connection_methods[0];
    if (!method) throw new Error("Missing synthetic method.");
    method.gateways = ["example-gateway"];
    method.vpn_profile_id = "example-vpn";
    method.target.identity_file = "example-private-key";
    saved.remote_identity = "example-identity";
    const { client, calls, env } = harness([
      {
        exit_code: 0,
        stdout: JSON.stringify([{ host: saved, statuses: [] }]),
      },
    ]);
    expect(await client.listHosts()).toEqual([saved]);
    expect(calls).toEqual([
      {
        args: ["host", "list", "--json"],
        options: { env, inherit_stdio: false },
      },
    ]);
  });

  test("accepts an empty saved-host catalog", async () => {
    const { client } = harness([{ exit_code: 0, stdout: "[]" }]);
    expect(await client.listHosts()).toEqual([]);
  });

  test("reads unrelated Windows and domain usernames without applying instance-login input rules", async () => {
    for (const user of [
      "EXAMPLE\\example-user",
      "example-user@example.invalid",
    ]) {
      const saved = structuredClone(host);
      const method = saved.connection_methods[0];
      if (!method) throw new Error("Missing synthetic method.");
      method.target.user = user;
      method.target.identity_file = "-example-key";
      const { client } = harness([
        { exit_code: 0, stdout: JSON.stringify([{ host: saved }]) },
      ]);
      expect(await client.listHosts()).toEqual([saved]);
    }
  });

  test("uses the shared SSH username rules for new and updated instance settings", async () => {
    const { client, calls } = harness();
    const settings = { ...input, user: "example-user$" };
    await client.createHost(settings);
    await client.updateHost(host.host_id, host.preferred_method_id, settings);
    for (const call of calls) {
      expect(call.args[call.args.indexOf("--user") + 1]).toBe("example-user$");
    }
  });

  test("creates a named managed method with each value as one argv argument", async () => {
    const { client, calls } = harness();
    expect(await client.createHost(input)).toEqual(host);
    expect(calls[0]?.args).toEqual([
      "host",
      "create",
      "example-host",
      "server.example.invalid",
      "--method-name",
      "vpsctl",
      "--port",
      "2222",
      "--user",
      "example-user",
      "--identity-file",
      "example keys/private-key",
      "--json",
    ]);
    expect(calls[0]?.options.inherit_stdio).toBe(false);
  });

  test("omits optional create settings rather than passing empty values", async () => {
    const { client, calls } = harness();
    await client.createHost({
      name: input.name,
      destination: input.destination,
      port: 22,
    });
    expect(calls[0]?.args).toEqual([
      "host",
      "create",
      input.name,
      input.destination,
      "--method-name",
      "vpsctl",
      "--port",
      "22",
      "--json",
    ]);
  });

  test("updates the specific method and stable name without clearing saved routes or identity", async () => {
    const { client, calls } = harness();
    expect(
      await client.updateHost(host.host_id, host.preferred_method_id, {
        name: input.name,
        destination: input.destination,
        port: 2222,
      }),
    ).toEqual(host);
    expect(calls[0]?.args).toEqual([
      "host",
      "update",
      host.host_id,
      "--method",
      host.preferred_method_id,
      "--name",
      input.name,
      "--destination",
      input.destination,
      "--port",
      "2222",
      "--json",
    ]);
    expect(calls[0]?.args).not.toContain("--clear");
    expect(calls[0]?.args).not.toContain("--identity-file");
    expect(calls[0]?.args).not.toContain("--user");
  });

  test("passes explicitly requested user and identity changes to update", async () => {
    const { client, calls } = harness();
    await client.updateHost(host.host_id, host.preferred_method_id, input);
    expect(calls[0]?.args.slice(-5)).toEqual([
      "--user",
      input.user ?? "",
      "--identity-file",
      input.identity_file ?? "",
      "--json",
    ]);
  });

  test("connects the selected method with inherited terminal and preserves the SSH exit status", async () => {
    const { client, calls, env } = harness([{ exit_code: 7, stdout: "" }]);
    expect(await client.connect(host.host_id, host.preferred_method_id)).toBe(
      7,
    );
    expect(calls).toEqual([
      {
        args: ["--method", host.preferred_method_id, "ssh", host.host_id],
        options: { env, inherit_stdio: true },
      },
    ]);
  });

  test("uses a transient askpass helper and bypasses managed or configured SSH masters for provider passwords", async () => {
    const { client, calls, env } = harness([{ exit_code: 7, stdout: "" }]);

    expect(
      await client.connect(
        host.host_id,
        host.preferred_method_id,
        password_authentication,
      ),
    ).toBe(7);

    const call = calls[0];
    if (!call) throw new Error("Expected a ctl connection.");
    expect(call.args.slice(0, 3)).toEqual([
      "--method",
      host.preferred_method_id,
      "ssh",
    ]);
    expect(call.args.at(-1)).toBe(host.host_id);
    const options = call.args.slice(3, -1);
    expect(options.length % 2).toBe(0);
    for (let index = 0; index < options.length; index += 2) {
      expect(options[index]).toBe("-o");
    }
    for (const option of [
      "PreferredAuthentications=password",
      "PasswordAuthentication=yes",
      "PubkeyAuthentication=no",
      "KbdInteractiveAuthentication=no",
      "BatchMode=no",
      "NumberOfPasswordPrompts=1",
      "ControlMaster=no",
      "ControlPath=none",
      "ProxyCommand=none",
      "ProxyJump=none",
      `HostName=${password_authentication.host}`,
      `User=${password_authentication.user}`,
      `Port=${password_authentication.port}`,
    ]) {
      expect(options).toContain(option);
    }
    expect(call.options.inherit_stdio).toBe(true);
    expect(call.options.env).toMatchObject({
      ...env,
      SSH_ASKPASS_REQUIRE: "force",
      LC_ALL: "C",
      LANG: "C",
    });
    expect(call.options.env.SSH_ASKPASS).toBeTruthy();
    expect(JSON.stringify(calls)).not.toContain(
      password_authentication.password,
    );
  });

  test("validates password authentication endpoints before starting ctl", async () => {
    for (const invalid of [
      { ...password_authentication, user: "other user" },
      { ...password_authentication, host: "-invalid" },
      { ...password_authentication, port: 0 },
      { ...password_authentication, port: 65536 },
    ]) {
      const { client, calls } = harness();
      const error = await errorFrom(
        client.connect(host.host_id, host.preferred_method_id, invalid),
      );

      expect(error.code).toBe("invalid_input");
      expect(error.message).not.toContain(password_authentication.password);
      expect(calls).toEqual([]);
    }
  });

  test("delivers the password through the generated askpass process and removes the helper after the session", async () => {
    let helper_path = "";
    const client = createCtlClient({}, async (args, options) => {
      const helper = options.env.SSH_ASKPASS;
      if (!helper) throw new Error("Expected a temporary askpass helper.");
      helper_path = helper;
      expect(await readFile(helper_path, "utf8")).not.toContain(
        password_authentication.password,
      );
      expect(JSON.stringify({ args, options })).not.toContain(
        password_authentication.password,
      );
      expect(options.inherit_stdio).toBe(true);
      const process = Bun.spawn(
        [
          helper_path,
          `${password_authentication.user}@${password_authentication.host}'s password: `,
        ],
        {
          env: { ...options.env },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, exit_code] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ]);
      expect(exit_code).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toBe(`${password_authentication.password}\n`);
      return { exit_code: 23, stdout: "" };
    });

    expect(
      await client.connect(
        host.host_id,
        host.preferred_method_id,
        password_authentication,
      ),
    ).toBe(23);
    expect(helper_path).not.toBe("");
    expect(await Bun.file(helper_path).exists()).toBe(false);
  });

  test("sanitizes password-connection spawn errors while keeping secrets out of process arguments and environment", async () => {
    for (const code of ["ENOENT", "EACCES"]) {
      let process_input = "";
      let helper_path = "";
      const client = createCtlClient({}, async (args, options) => {
        process_input = JSON.stringify({ args, options });
        helper_path = options.env.SSH_ASKPASS ?? "";
        throw Object.assign(new Error(password_authentication.password), {
          code,
        });
      });

      const error = await errorFrom(
        client.connect(
          host.host_id,
          host.preferred_method_id,
          password_authentication,
        ),
      );

      expect(error.code).toBe(
        code === "ENOENT" ? "not_found" : "provider_error",
      );
      expect(error.message).not.toContain(password_authentication.password);
      expect(process_input).not.toContain(password_authentication.password);
      expect(helper_path).not.toBe("");
      expect(await Bun.file(helper_path).exists()).toBe(false);
    }
  });

  test("accepts IPv4, IPv6, and absolute DNS endpoints without a shell", async () => {
    for (const destination of [
      "192.0.2.10",
      "2001:db8::10",
      "[2001:db8::10]",
      "server.example.invalid.",
    ]) {
      const { client, calls } = harness();
      await client.createHost({ ...input, destination });
      expect(calls[0]?.args[3]).toBe(destination);
    }
  });

  test("rejects unsafe or malformed connection input before invoking ctl", async () => {
    const invalid_inputs = [
      { ...input, name: "--help" },
      { ...input, name: "example\nname" },
      { ...input, name: "example\u202ename" },
      { ...input, destination: "-oProxyCommand=example" },
      { ...input, destination: "example;command" },
      { ...input, destination: "example user@example.invalid" },
      { ...input, destination: "user@example.invalid" },
      { ...input, destination: "https://example.invalid" },
      { ...input, destination: "example..invalid" },
      { ...input, destination: "example.invalid.." },
      { ...input, destination: "fe80::1%example" },
      { ...input, destination: "[fe80::1%example]" },
      { ...input, destination: "a".repeat(64) },
      { ...input, destination: "example\u0000.invalid" },
      { ...input, user: "--help" },
      { ...input, user: "example user" },
      { ...input, user: "example@user" },
      { ...input, user: "EXAMPLE\\example-user" },
      { ...input, user: "example$user" },
      { ...input, user: "$" },
      { ...input, user: "example;command" },
      { ...input, user: "example\nuser" },
      { ...input, identity_file: "--help" },
      { ...input, identity_file: "example\nkey" },
      { ...input, port: 0 },
      { ...input, port: 65536 },
      { ...input, port: 22.5 },
      { ...input, port: Number.NaN },
    ];
    for (const invalid of invalid_inputs) {
      const { client, calls } = harness();
      expect((await errorFrom(client.createHost(invalid))).code).toBe(
        "invalid_input",
      );
      expect(
        (
          await errorFrom(
            client.updateHost(host.host_id, host.preferred_method_id, invalid),
          )
        ).code,
      ).toBe("invalid_input");
      expect(calls).toHaveLength(0);
    }
  });

  test("rejects option and control characters in host or method IDs before invocation", async () => {
    for (const invalid_id of [
      "",
      "--help",
      "bad id",
      "bad\nid",
      "bad/id",
      "id;command",
    ]) {
      const { client, calls } = harness();
      expect(
        (await errorFrom(client.connect(invalid_id, host.preferred_method_id)))
          .code,
      ).toBe("invalid_input");
      expect(
        (await errorFrom(client.connect(host.host_id, invalid_id))).code,
      ).toBe("invalid_input");
      expect(
        (
          await errorFrom(
            client.updateHost(invalid_id, host.preferred_method_id, input),
          )
        ).code,
      ).toBe("invalid_input");
      expect(
        (await errorFrom(client.updateHost(host.host_id, invalid_id, input)))
          .code,
      ).toBe("invalid_input");
      expect(calls).toHaveLength(0);
    }
  });

  test("rejects malformed JSON, unwrapped list output, and invalid host references", async () => {
    const missing_preferred = {
      ...host,
      preferred_method_id: "missing-method",
    };
    const duplicate_method = {
      ...host,
      connection_methods: [
        ...host.connection_methods,
        ...host.connection_methods,
      ],
    };
    for (const stdout of [
      "not JSON: synthetic-secret",
      "null",
      JSON.stringify([host]),
      JSON.stringify([{ host: { ...host, host_id: "--help" } }]),
      JSON.stringify([{ host: { ...host, host_id: "control\nid" } }]),
      JSON.stringify([{ host: { ...host, connection_methods: [] } }]),
      JSON.stringify([{ host: missing_preferred }]),
      JSON.stringify([{ host: duplicate_method }]),
      JSON.stringify([{ host }, { host }]),
    ]) {
      const { client } = harness([{ exit_code: 0, stdout }]);
      const error = await errorFrom(client.listHosts());
      expect(error.code).toBe("invalid_response");
      expect(error.message).not.toContain("synthetic-secret");
      expect(error.message).not.toContain(stdout);
    }
  });

  test("rejects wrapped or malformed create results instead of trusting IDs", async () => {
    for (const value of [
      { host },
      { ...host, host_id: "--help" },
      { ...host, preferred_method_id: "unrelated-method" },
      {
        ...host,
        connection_methods: [
          { ...host.connection_methods[0], method_id: "bad\nid" },
        ],
      },
    ]) {
      const { client } = harness([
        { exit_code: 0, stdout: JSON.stringify(value) },
      ]);
      expect((await errorFrom(client.createHost(input))).code).toBe(
        "invalid_response",
      );
    }
  });

  test("rejects update responses that changed the selected host or removed the selected method", async () => {
    for (const returned of [
      { ...host, host_id: "different-host" },
      {
        ...host,
        connection_methods: [
          { ...host.connection_methods[0], method_id: "other-method" },
        ],
        preferred_method_id: "other-method",
      },
    ]) {
      const { client } = harness([
        { exit_code: 0, stdout: JSON.stringify(returned) },
      ]);
      expect(
        (
          await errorFrom(
            client.updateHost(host.host_id, host.preferred_method_id, input),
          )
        ).code,
      ).toBe("invalid_response");
    }
  });

  test("keeps endpoint overrides visible for the orchestration conflict check", async () => {
    const saved = structuredClone(host);
    const method = saved.connection_methods[0];
    if (!method) throw new Error("Missing synthetic method.");
    method.target.hostname = "override.example.invalid";
    method.ssh_config_alias = "example-alias";
    method.tailscale_node_id = "example-node";
    const { client } = harness([
      { exit_code: 0, stdout: JSON.stringify([{ host: saved }]) },
    ]);
    expect((await client.listHosts())[0]?.connection_methods[0]).toEqual(
      method,
    );
  });

  test("curates failed catalog operations without revealing output", async () => {
    for (const operation of ["list", "create", "update"] as const) {
      const { client } = harness([
        { exit_code: 3, stdout: "synthetic-secret" },
      ]);
      const error = await errorFrom(
        operation === "list"
          ? client.listHosts()
          : operation === "create"
            ? client.createHost(input)
            : client.updateHost(host.host_id, host.preferred_method_id, input),
      );
      expect(error.code).toBe("provider_error");
      expect(error.message).toContain("exit 3");
      expect(error.message).not.toContain("synthetic-secret");
    }
  });

  test("reports missing ctl with actionable installation guidance and sanitizes other spawn errors", async () => {
    for (const code of ["ENOENT", "EACCES", undefined]) {
      const client = createCtlClient({}, async () => {
        throw Object.assign(new Error("synthetic-secret"), { code });
      });
      const error = await errorFrom(client.listHosts());
      expect(error.code).toBe(
        code === "ENOENT" ? "not_found" : "provider_error",
      );
      if (code === "ENOENT") expect(error.message).toContain("Install ctl");
      expect(error.message).not.toContain("synthetic-secret");
    }
  });

  test("uses the provided PATH and environment in the real subprocess adapter", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vpsctl-ctl-test-"));
    try {
      const executable = join(directory, "ctl");
      const arguments_path = join(directory, "arguments.txt");
      await writeFile(
        executable,
        '#!/bin/sh\nprintf "%s\\n" "$@" > "$CTL_ARGUMENTS_PATH"\nprintf "%s\\n" "$CTL_SYNTHETIC_RESPONSE"\nprintf "%s\\n" "synthetic-secret" >&2\nexit "$CTL_SYNTHETIC_EXIT"\n',
      );
      await chmod(executable, 0o700);
      const env = {
        PATH: directory,
        CTL_ARGUMENTS_PATH: arguments_path,
        CTL_SYNTHETIC_RESPONSE: JSON.stringify([{ host, statuses: [] }]),
        CTL_SYNTHETIC_EXIT: "0",
      };
      expect(await createCtlClient(env).listHosts()).toEqual([host]);
      expect(await readFile(arguments_path, "utf8")).toBe(
        "host\nlist\n--json\n",
      );
      const error = await errorFrom(
        createCtlClient({ ...env, CTL_SYNTHETIC_EXIT: "9" }).listHosts(),
      );
      expect(error.message).toContain("exit 9");
      expect(error.message).not.toContain("synthetic-secret");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("reports a missing executable from the real subprocess adapter", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vpsctl-ctl-missing-"));
    try {
      const error = await errorFrom(
        createCtlClient({ PATH: directory }).listHosts(),
      );
      expect(error.code).toBe("not_found");
      expect(error.message).toContain("Install ctl");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
