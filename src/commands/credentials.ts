import type { Account } from "../core/accounts.ts";
import { AppError } from "../core/errors.ts";
import type { ProviderDefinition } from "../core/provider.ts";
import type { CliCommand } from "./command.ts";
import type { CliIO } from "./context.ts";
import { collect, credentialsFromFlags } from "./input.ts";

export interface CredentialOptions {
  credential: string[];
  credentials_stdin?: boolean;
}

export function withCredentialOptions(command: CliCommand): CliCommand {
  return command
    .option(
      "--credential <field=ENV_VAR>",
      "Use an environment variable reference; repeat for more fields",
      collect,
      [],
    )
    .option(
      "--credentials-stdin",
      "Read a JSON object of credential field/value pairs from stdin",
    );
}

export async function readCredentials(
  definition: ProviderDefinition,
  io: CliIO,
  flags: CredentialOptions,
): Promise<Account["credentials"]> {
  if (flags.credentials_stdin) {
    if (flags.credential.length > 0) {
      throw new AppError(
        "invalid_input",
        "Use --credential or --credentials-stdin, not both.",
      );
    }
    if (!io.read_stdin) {
      throw new AppError(
        "invalid_input",
        "Credential stdin input is unavailable.",
      );
    }
    let values: unknown;
    try {
      values = JSON.parse(await io.read_stdin());
    } catch {
      throw new AppError(
        "invalid_input",
        "Credentials must be a JSON object of field/value pairs.",
      );
    }
    if (
      !values ||
      typeof values !== "object" ||
      Array.isArray(values) ||
      Object.values(values).some(
        (value) => typeof value !== "string" || !value.trim(),
      )
    ) {
      throw new AppError(
        "invalid_input",
        "Credentials must be a JSON object of nonempty string values.",
      );
    }
    return Object.fromEntries(
      Object.entries(values).map(([field, value]) => [
        field,
        { source: "literal", value: value as string },
      ]),
    );
  }
  if (flags.credential.length > 0) {
    return credentialsFromFlags(flags.credential);
  }
  if (!io.is_interactive || !io.read_secret) {
    throw new AppError(
      "invalid_input",
      "Account setup needs an interactive terminal, --credentials-stdin, or --credential field=ENV_VAR.",
    );
  }
  const entries = [];
  for (const field of definition.credential_fields) {
    entries.push([
      field,
      {
        source: "literal" as const,
        value: await io.read_secret(`${definition.info.id} ${field}`),
      },
    ]);
  }
  return Object.fromEntries(entries);
}
