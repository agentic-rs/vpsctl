import type { Account } from "../core/accounts.ts";
import { AppError } from "../core/errors.ts";
import type { Instance } from "../core/provider.ts";

export function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function nonblank(value: string, label: string): string {
  if (!value.trim())
    throw new AppError("invalid_input", `${label} cannot be empty.`);
  return value;
}

export function instanceId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) || value.includes("..")) {
    throw new AppError(
      "invalid_input",
      "Instance ID must be a single nonempty identifier.",
    );
  }
  return value;
}

export function summary(instance: Instance): Record<string, unknown> {
  return {
    id: instance.id,
    label: instance.label,
    status: instance.status,
    region_id: instance.region_id,
    plan_id: instance.plan_id,
    public_ipv4: instance.public_ipv4,
  };
}

export function credentialsFromFlags(values: string[]): Account["credentials"] {
  const credentials: Account["credentials"] = {};
  for (const value of values) {
    const parts = /^([a-z][a-z0-9_]*)=([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
    if (!parts?.[1] || !parts[2]) {
      throw new AppError(
        "invalid_input",
        "Use --credential field=ENV_VAR, for example api_key=VULTR_WORK_API_KEY.",
      );
    }
    const [, field, name] = parts;
    if (Object.hasOwn(credentials, field)) {
      throw new AppError(
        "invalid_input",
        `Credential '${field}' was specified more than once.`,
      );
    }
    Object.defineProperty(credentials, field, {
      value: { source: "env", name },
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return credentials;
}
