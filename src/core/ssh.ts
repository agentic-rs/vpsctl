import { isIP } from "node:net";
import { AppError } from "./errors.ts";
import type { Instance } from "./provider.ts";

export interface SshConnection {
  host: string;
  port: number;
  user?: string;
  method: "direct" | "proxy";
}

export interface SshConnectionOptions {
  user?: string;
  port?: number;
}

export function validateSshUser(user: string): string {
  if (
    user.length > 256 ||
    /[\s\p{C}]/u.test(user) ||
    !/^[A-Za-z0-9_][A-Za-z0-9_.-]*\$?$/.test(user)
  ) {
    throw new AppError("invalid_input", "Use a valid SSH username.");
  }
  return user;
}

function validateHost(host: string): string {
  const is_address = !host.includes("%") && isIP(host) !== 0;
  const is_hostname =
    host.length <= 253 &&
    !/[\s\p{C}]/u.test(host) &&
    host
      .replace(/\.$/, "")
      .split(".")
      .every((label) =>
        /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label),
      );
  if (!is_address && !is_hostname) {
    throw new AppError(
      "invalid_input",
      "The instance has an invalid SSH hostname or IP address.",
    );
  }
  return host;
}

function validatePort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AppError(
      "invalid_input",
      "SSH port must be between 1 and 65535.",
    );
  }
  return port;
}

export function resolveSshConnection(
  instance: Instance,
  options: SshConnectionOptions = {},
): SshConnection {
  if (instance.status !== "running") {
    throw new AppError(
      "conflict",
      "The instance must be running before login. Check its state and retry.",
    );
  }

  let host = instance.ssh_host;
  let port = options.port ?? instance.ssh_port;
  if (host === undefined && instance.provider_id === "vultr") {
    host = [instance.public_ipv4, instance.public_ipv6].find(
      (address) => isIP(address) !== 0,
    );
    port ??= 22;
  }
  if (host === undefined || port === undefined) {
    throw new AppError(
      "invalid_input",
      "The instance has no published SSH endpoint. Check its connection settings and retry.",
    );
  }

  const method = instance.ssh_method ?? "direct";
  const user =
    options.user ??
    instance.ssh_user ??
    (instance.provider_id === "vast" ? "root" : undefined);
  if (method === "proxy" && user === undefined) {
    throw new AppError(
      "invalid_input",
      "The SSH proxy username is missing. Use the provider's connection username with --user.",
    );
  }
  return {
    host: validateHost(host),
    port: validatePort(port),
    method,
    ...(user === undefined ? {} : { user: validateSshUser(user) }),
  };
}
