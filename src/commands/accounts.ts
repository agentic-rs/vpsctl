import { type Account, validateAccountId } from "../core/accounts.ts";
import type { CliCommand } from "./command.ts";
import type { CommandContext } from "./context.ts";
import {
  type CredentialOptions,
  readCredentials,
  withCredentialOptions,
} from "./credentials.ts";

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
  const account_add = withCredentialOptions(
    accounts
      .command("add <id>")
      .description("Register an account; prompts for credentials by default")
      .requiredOption("--provider <id>", "Registered provider ID"),
  );
  account_add.action(async (id: string) => {
    validateAccountId(id);
    const flags = account_add.opts<CredentialOptions & { provider: string }>();
    const definition = registry.get(flags.provider);
    const account: Account = {
      id,
      provider_id: flags.provider,
      credentials: await readCredentials(definition, io, flags),
    };
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
