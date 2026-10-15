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
import { registerLoginCommand } from "./login.ts";
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

export function registerAuthCommands(
  program: CliCommand,
  context: CommandContext,
): void {
  const { registry, io, print, storeFor, readProvider } = context;
  const auth = program
    .command("auth")
    .description("Authenticate and manage local provider accounts");
  registerLoginCommand(auth, context);
  const get = auth
    .command("get")
    .description(
      "Query identity, balance, pending charges, and payment metadata",
    )
    .option("--all-accounts", "Query metadata across all configured accounts");
  get.action(async () => {
    const flags = get.optsWithGlobals<
      CommonOptions & { all_accounts?: boolean }
    >();
    if (!flags.all_accounts) {
      await readProvider(get, "auth.get", accountMetadata);
      return;
    }
    const results = await queryAllAccounts(get, context, accountMetadata);
    if (flags.json) {
      print(
        get,
        "auth.get",
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
      io.write_out("No accounts configured. Run 'auth login'.\n");
  });
  const list = auth
    .command("list")
    .description("List accounts without reading credentials");
  list.action(async () => {
    const config = await storeFor(list).read();
    print(
      list,
      "auth.list",
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
  const add = withCredentialOptions(
    auth
      .command("add <id>")
      .description("Register an account; prompts for credentials by default")
      .option(
        "--provider <id>",
        "Provider ID (choose interactively if omitted)",
      ),
  );
  add.action(async (id: string) => {
    validateAccountId(id);
    const flags = add.optsWithGlobals<
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
    await storeFor(add).add(account);
    print(add, "auth.add", { id, provider_id: account.provider_id });
  });
  const use = auth.command("use <id>").description("Set the default account");
  use.action(async (id: string) => {
    await storeFor(use).use(id);
    print(use, "auth.use", { default_account_id: id });
  });
  const remove = auth
    .command("remove <id>")
    .description(
      "Remove a local account reference; Provider resources are unaffected",
    );
  remove.action(async (id: string) => {
    await storeFor(remove).remove(id);
    print(remove, "auth.remove", { removed_account_id: id });
  });
}
