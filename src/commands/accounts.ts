import type { Account } from "../core/accounts.ts";
import { AppError } from "../core/errors.ts";
import type { CliCommand } from "./command.ts";
import type { CommandContext } from "./context.ts";
import { collect, credentialsFromFlags } from "./input.ts";

export function registerAccountCommands(
  program: CliCommand,
  context: CommandContext,
): void {
  const { registry, io, print, storeFor } = context;
  const provider_group = program
    .command("provider")
    .description("Inspect registered providers");
  const provider_list = provider_group
    .command("list")
    .description("List providers and capabilities");
  provider_list.action(() =>
    print(
      provider_list,
      "provider.list",
      registry
        .list()
        .map(({ info, credential_fields }) => ({ ...info, credential_fields })),
    ),
  );

  const accounts = program
    .command("account")
    .description("Manage local named accounts and credential references");
  const account_list = accounts
    .command("list")
    .description("List accounts without reading credentials");
  account_list.action(async () => {
    const config = await storeFor(account_list).read();
    print(
      account_list,
      "account.list",
      config.accounts.map((account) => ({
        id: account.id,
        provider_id: account.provider_id,
        is_default: config.default_account_id === account.id,
        credentials: Object.fromEntries(
          Object.entries(account.credentials).map(([field, reference]) => [
            field,
            reference.source === "literal"
              ? { source: "literal", value: "[redacted]" }
              : reference,
          ]),
        ),
      })),
    );
  });
  const account_add = accounts
    .command("add <id>")
    .description("Register an account; prompts for credentials by default")
    .requiredOption("--provider <id>", "Registered provider ID")
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
  account_add.action(async (id: string) => {
    const flags = account_add.opts<{
      provider: string;
      credential: string[];
      credentials_stdin?: boolean;
    }>();
    const definition = registry.get(flags.provider);
    let credentials: Account["credentials"];
    if (flags.credentials_stdin) {
      if (flags.credential.length > 0)
        throw new AppError(
          "invalid_input",
          "Use --credential or --credentials-stdin, not both.",
        );
      if (!io.read_stdin)
        throw new AppError(
          "invalid_input",
          "Credential stdin input is unavailable.",
        );
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
      credentials = Object.fromEntries(
        Object.entries(values).map(([field, value]) => [
          field,
          { source: "literal", value: value as string },
        ]),
      );
    } else if (flags.credential.length > 0) {
      credentials = credentialsFromFlags(flags.credential);
    } else {
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
            value: await io.read_secret(`${flags.provider} ${field}`),
          },
        ]);
      }
      credentials = Object.fromEntries(entries);
    }
    const account: Account = { id, provider_id: flags.provider, credentials };
    registry.validateAccount(account);
    await storeFor(account_add).add(account);
    print(account_add, "account.add", { id, provider_id: account.provider_id });
  });
  const account_use = accounts
    .command("use <id>")
    .description("Set the default account");
  account_use.action(async (id: string) => {
    await storeFor(account_use).use(id);
    print(account_use, "account.use", { default_account_id: id });
  });
  const account_remove = accounts
    .command("remove <id>")
    .description(
      "Remove a local account reference; VPS resources are unaffected",
    );
  account_remove.action(async (id: string) => {
    await storeFor(account_remove).remove(id);
    print(account_remove, "account.remove", { removed_account_id: id });
  });
}
