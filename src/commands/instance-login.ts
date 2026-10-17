import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { Account } from "../core/accounts.ts";
import type { CtlHost, CtlHostInput, CtlMethod } from "../core/ctl.ts";
import { AppError } from "../core/errors.ts";
import type {
  Instance,
  InstanceLoginCredential,
  Provider,
} from "../core/provider.ts";
import { resolveSshConnection, validateSshUser } from "../core/ssh.ts";
import { validateSshPassword } from "../core/ssh-password.ts";
import type { CliCommand } from "./command.ts";
import type { CommandContext, CommonOptions } from "./context.ts";
import { nonblank, positiveInteger } from "./input.ts";
import { sanitizeTerminalText } from "./output.ts";

interface LoginOptions extends CommonOptions {
  auth?: "provider" | "ctl";
  user?: string;
  port?: number;
  identity_file?: string;
}

function authMethod(value: string): "provider" | "ctl" {
  if (value !== "provider" && value !== "ctl") {
    throw new AppError(
      "invalid_input",
      "Authentication must be provider or ctl.",
    );
  }
  return value;
}

function requireDirectPasswordMethod(method: CtlMethod): void {
  const target = method.target;
  if (
    target.vpn_connection_id ||
    (Array.isArray(target.gateway_route) && target.gateway_route.length) ||
    (Array.isArray(target.gateways) && target.gateways.length)
  ) {
    throw new AppError(
      "unsupported_operation",
      "Provider-password login requires a direct ctl connection method. Use --auth ctl for saved gateway or VPN routes.",
    );
  }
}

async function loginCredential(
  provider: Provider,
  instance: Instance,
  requested_user?: string,
): Promise<InstanceLoginCredential> {
  let credential: InstanceLoginCredential | undefined;
  try {
    credential = await provider.getInstanceLoginCredential?.(instance.id);
  } catch (error) {
    throw new AppError(
      error instanceof AppError ? error.code : "provider_error",
      "Unable to retrieve the instance login credential from the provider.",
      error instanceof AppError ? error.status_code : undefined,
    );
  }
  if (credential === undefined) {
    throw new AppError(
      "not_found",
      "The provider password is unavailable or has expired. Use --auth ctl to choose ctl-managed authentication instead.",
    );
  }
  if (
    typeof credential !== "object" ||
    credential === null ||
    typeof credential.user !== "string"
  ) {
    throw new AppError(
      "invalid_response",
      "The provider returned an invalid instance login credential.",
    );
  }
  validateSshPassword(credential.password);
  try {
    validateSshUser(credential.user);
  } catch {
    throw new AppError(
      "invalid_response",
      "The provider returned an invalid instance login credential.",
    );
  }
  if (
    (requested_user !== undefined && requested_user !== credential.user) ||
    (instance.ssh_user !== undefined && instance.ssh_user !== credential.user)
  ) {
    throw new AppError(
      "invalid_input",
      "The provider password belongs to a different SSH username. Use the provider credential's username for password login.",
    );
  }
  return credential;
}

function sshPort(value: string): number {
  const port = positiveInteger(value);
  if (port > 65535)
    throw new AppError(
      "invalid_input",
      "SSH port must be between 1 and 65535.",
    );
  return port;
}

function identityPath(value: string, env: CommandContext["env"]): string {
  nonblank(value, "Identity file");
  if (/\p{C}/u.test(value))
    throw new AppError(
      "invalid_input",
      "Use an identity file path without control characters.",
    );
  if (value === "~") return env.HOME ?? homedir();
  if (value.startsWith("~/"))
    return resolve(env.HOME ?? homedir(), value.slice(2));
  if (value.startsWith("~"))
    throw new AppError(
      "invalid_input",
      "Use ~/ or an absolute identity file path.",
    );
  return resolve(value);
}

function hostName(account: Account, instance_id: string): string {
  const key = JSON.stringify([account.provider_id, account.id, instance_id]);
  return `vpsctl-${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
}

function managedMethod(host: CtlHost): CtlMethod {
  const methods = host.connection_methods.filter(
    (method) => method.name === "vpsctl",
  );
  if (methods.length !== 1)
    throw new AppError(
      "conflict",
      "The saved ctl host must have exactly one connection method named vpsctl. Resolve the catalog conflict with ctl before retrying.",
    );
  const method = methods[0];
  if (method === undefined)
    throw new AppError(
      "invalid_response",
      "The saved ctl connection method is missing.",
    );
  if (
    method.target.kind !== "ssh" ||
    method.target.hostname ||
    method.ssh_config_alias ||
    method.tailscale_node_id
  ) {
    throw new AppError(
      "conflict",
      "The managed ctl method has an endpoint override. Remove its hostname, SSH alias, or Tailscale override with ctl before refreshing the instance endpoint.",
    );
  }
  return method;
}

async function selectInstance(
  selector: string | undefined,
  provider: Provider,
  context: CommandContext,
): Promise<Instance> {
  const { io } = context;
  if (selector === undefined && (!io.is_interactive || !io.select)) {
    throw new AppError(
      "invalid_input",
      "Supply an instance ID or name in noninteractive mode.",
    );
  }
  const inventory = await provider.listInstances();
  if (
    inventory.some((item) => item.provider_id !== provider.info.id) ||
    new Set(inventory.map((item) => item.id)).size !== inventory.length
  ) {
    throw new AppError(
      "invalid_response",
      "The provider returned inconsistent instance identities.",
    );
  }
  if (selector !== undefined) {
    const exact = inventory.find((item) => item.id === selector);
    if (exact) return exact;
    const named = inventory.filter((item) => item.label === selector);
    if (named.length > 1)
      throw new AppError(
        "conflict",
        "The instance name is ambiguous. Use its full instance ID.",
      );
    if (named[0]) return named[0];
    throw new AppError(
      "not_found",
      "No instance matches that ID or name in the selected account.",
    );
  }
  const candidates = inventory.filter((item) => item.status === "running");
  if (candidates.length === 0)
    throw new AppError(
      "not_found",
      "No running instances are available for login. Use instance list to inspect their state.",
    );
  const selected = await io.select?.(
    "Choose an instance",
    candidates.map((item) => ({
      value: item.id,
      label: sanitizeTerminalText(
        item.label ? `${item.label} (${item.id})` : item.id,
      ),
      hint: sanitizeTerminalText(
        [item.region_id, item.status].filter(Boolean).join(" · "),
      ),
    })),
    { searchable: true },
  );
  const instance = candidates.find((item) => item.id === selected);
  if (!instance)
    throw new AppError(
      "invalid_input",
      "Choose one of the available instances.",
    );
  return instance;
}

export function registerInstanceLoginCommand(
  instances: CliCommand,
  context: CommandContext,
): void {
  const login = instances
    .command("login [instance]")
    .alias("ssh")
    .description(
      "Refresh a saved ctl host from an instance and open its SSH session",
    )
    .option("--user <user>", "Override the SSH username", validateSshUser)
    .option(
      "--auth <method>",
      "provider password when supported, or ctl-managed authentication",
      authMethod,
    )
    .option("--port <port>", "Override the SSH port", sshPort)
    .option(
      "-i, --identity-file <path>",
      "Save an SSH key file reference in ctl",
    )
    .option(
      "--dry-run",
      "Resolve current connection details without saving a host or connecting",
    );
  login.action(async (selector?: string) => {
    const flags = login.optsWithGlobals<LoginOptions>();
    if (flags.json && !flags.dry_run)
      throw new AppError(
        "invalid_input",
        "JSON instance login requires --dry-run. Interactive SSH uses the terminal.",
      );
    if (
      selector === undefined &&
      (flags.json || !context.io.is_interactive || !context.io.select)
    ) {
      throw new AppError(
        "invalid_input",
        "Supply an instance ID or name in JSON or noninteractive mode.",
      );
    }
    if (selector !== undefined) nonblank(selector, "Instance ID or name");
    const identity_file =
      flags.identity_file === undefined
        ? undefined
        : identityPath(flags.identity_file, context.env);
    const { account, display_id } = await context.selectedAccount(login);
    const provider = context.registry.connect(account, context.env);
    const auth =
      flags.auth ?? (provider.getInstanceLoginCredential ? "provider" : "ctl");
    if (auth === "provider" && !provider.getInstanceLoginCredential) {
      throw new AppError(
        "unsupported_operation",
        "This provider does not expose instance passwords. Use --auth ctl for SSH key or interactive authentication.",
      );
    }
    const chosen = await selectInstance(selector, provider, context);
    context.registry.get(account.provider_id).validateInstanceId?.(chosen.id);
    const instance = await provider.getInstance(chosen.id);
    if (
      instance.id !== chosen.id ||
      instance.provider_id !== account.provider_id ||
      provider.info.id !== account.provider_id
    ) {
      throw new AppError(
        "invalid_response",
        "The provider returned a different instance or provider identity.",
      );
    }
    // Validate current endpoint and state before touching even the ctl catalog.
    const preliminary = resolveSshConnection(instance, {
      ...(flags.user === undefined ? {} : { user: flags.user }),
      ...(flags.port === undefined ? {} : { port: flags.port }),
    });
    const name = hostName(account, instance.id);
    const hosts = (await context.ctl.listHosts()).filter(
      (host) => host.name === name,
    );
    if (hosts.length > 1)
      throw new AppError(
        "conflict",
        "Multiple saved ctl hosts match this instance. Resolve the duplicate managed hosts with ctl before retrying.",
      );
    const existing = hosts[0];
    const method = existing === undefined ? undefined : managedMethod(existing);
    const credential =
      !flags.dry_run && auth === "provider"
        ? await loginCredential(provider, instance, flags.user)
        : undefined;
    if (credential && method) requireDirectPasswordMethod(method);
    let user =
      flags.user ??
      credential?.user ??
      instance.ssh_user ??
      method?.target.user ??
      preliminary.user;
    if (user === undefined) {
      if (!context.io.is_interactive || !context.io.read_text || flags.json) {
        throw new AppError(
          "invalid_input",
          "The SSH username is unknown. Supply --user or set the saved ctl method's user.",
        );
      }
      user = await context.io.read_text("SSH username", {
        initial_value: "root",
        validate(value) {
          try {
            validateSshUser(value.trim());
            return undefined;
          } catch {
            return "Use a valid SSH username.";
          }
        },
      });
      user = validateSshUser(user.trim());
    }
    const connection = resolveSshConnection(instance, {
      user,
      port:
        flags.port ??
        instance.ssh_port ??
        method?.target.port ??
        preliminary.port,
    });
    const input: CtlHostInput = {
      name,
      destination: connection.host,
      port: connection.port,
      user,
      ...(identity_file === undefined ? {} : { identity_file }),
    };
    if (flags.dry_run) {
      context.print(
        login,
        "instance.login",
        {
          instance_id: instance.id,
          auth_method: auth,
          host_name: name,
          operation: existing ? "update" : "create",
          connection,
          ...(identity_file === undefined ? {} : { identity_file }),
          ...(existing === undefined ? {} : { ctl_host_id: existing.host_id }),
          dry_run: true,
        },
        account,
        display_id,
      );
      return;
    }
    const saved =
      existing && method
        ? await context.ctl.updateHost(
            existing.host_id,
            method.method_id,
            input,
          )
        : await context.ctl.createHost(input);
    const saved_method = managedMethod(saved);
    if (
      saved.name !== name ||
      (existing &&
        (saved.host_id !== existing.host_id ||
          saved_method.method_id !== method?.method_id)) ||
      saved_method.target.destination !== connection.host ||
      (saved_method.target.port ?? 22) !== connection.port ||
      saved_method.target.user !== user ||
      (identity_file !== undefined &&
        saved_method.target.identity_file !== identity_file)
    ) {
      throw new AppError(
        "invalid_response",
        "ctl did not save the expected instance connection. Inspect the saved host before retrying.",
      );
    }
    if (credential) requireDirectPasswordMethod(saved_method);
    context.io.write_err(
      `Connecting to ${sanitizeTerminalText(instance.label || instance.id)} via ctl (${sanitizeTerminalText(display_id)}).\n`,
    );
    context.setExitCode(
      await context.ctl.connect(
        saved.host_id,
        saved_method.method_id,
        credential === undefined
          ? undefined
          : { ...connection, user, password: credential.password },
      ),
    );
  });
}
