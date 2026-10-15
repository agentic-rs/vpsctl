import { type Account, validateAccountId } from "../core/accounts.ts";
import { AppError } from "../core/errors.ts";
import type { AccountMetadata, Provider } from "../core/provider.ts";
import type { CliCommand } from "./command.ts";
import type { CommandContext, CommonOptions } from "./context.ts";
import {
  type CredentialOptions,
  readCredentials,
  withCredentialOptions,
} from "./credentials.ts";
import { render } from "./output.ts";
import { resolveProvider } from "./providers.ts";
import { queryAllAccounts } from "./query.ts";

async function accountMetadata(provider: Provider): Promise<AccountMetadata> {
  if (!provider.getAccountMetadata) {
    throw new AppError(
      "unsupported_operation",
      `Provider '${provider.info.id}' does not support account metadata.`,
    );
  }
  return provider.getAccountMetadata();
}

export function registerAccountCommands(
  program: CliCommand,
  context: CommandContext,
): void {
  const { registry, io, print, storeFor, readProvider } = context;
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
    .description("Manage named accounts and query provider metadata");
  const account_info = accounts
    .command("info")
    .description(
      "Query identity, balance, pending charges, and payment metadata",
    )
    .option("--all-accounts", "Query metadata across all configured accounts");
  account_info.action(async () => {
    const flags = account_info.optsWithGlobals<
      CommonOptions & { all_accounts?: boolean }
    >();
    if (!flags.all_accounts) {
      await readProvider(account_info, "account.info", accountMetadata);
      return;
    }
    const results = await queryAllAccounts(
      account_info,
      context,
      accountMetadata,
    );
    if (flags.json) {
      print(
        account_info,
        "account.info",
        results.map((result) =>
          "data" in result
            ? {
                account_id: result.account_id,
                provider_id: result.provider_id,
                metadata: result.data,
              }
            : result,
        ),
      );
      return;
    }
    for (const result of results) {
      io.write_out(`Account: ${result.account_id} (${result.provider_id})\n`);
      io.write_out(
        `${"data" in result ? render(result.data) : `Error: ${result.error}`}\n`,
      );
    }
    if (results.length === 0)
      io.write_out("No accounts configured. Run 'login'.\n");
  });
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
      .option(
        "--provider <id>",
        "Provider ID (choose interactively if omitted)",
      ),
  );
  account_add.action(async (id: string) => {
    validateAccountId(id);
    const flags = account_add.optsWithGlobals<
      CredentialOptions & CommonOptions & { provider?: string }
    >();
    const definition = await resolveProvider(context, {
      provider_id: flags.provider,
      account_id: id,
      allow_prompt: !flags.json && !flags.credentials_stdin,
    });
    const account: Account = {
      id,
      provider_id: definition.info.id,
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
