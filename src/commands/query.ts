import { accountDisplayId } from "../core/accounts.ts";
import { AppError } from "../core/errors.ts";
import type { Provider } from "../core/provider.ts";
import type { CliCommand } from "./command.ts";
import type { CommandContext, CommonOptions } from "./context.ts";

type AccountQueryResult<T> = {
  account_id: string;
  provider_id: string;
  display_id: string;
} & ({ data: T } | { error: string });

export async function queryAllAccounts<T>(
  command: CliCommand,
  context: CommandContext,
  query: (provider: Provider) => Promise<T>,
): Promise<AccountQueryResult<T>[]> {
  const { env, registry, storeFor, setExitCode } = context;
  const flags = command.optsWithGlobals<CommonOptions>();
  if (flags.account || env.VPS_CTL_ACCOUNT) {
    throw new AppError(
      "invalid_input",
      "--all/--all-accounts cannot be combined with --account or VPS_CTL_ACCOUNT.",
    );
  }
  const config = await storeFor(command).read();
  return Promise.all(
    config.accounts.map(async (account) => {
      const identity = {
        account_id: account.id,
        provider_id: account.provider_id,
        display_id: accountDisplayId(account, config.accounts),
      };
      try {
        return {
          ...identity,
          data: await query(registry.connect(account, env)),
        };
      } catch (error) {
        setExitCode(1);
        return {
          ...identity,
          error:
            error instanceof Error ? error.message : "Account request failed.",
        };
      }
    }),
  );
}
