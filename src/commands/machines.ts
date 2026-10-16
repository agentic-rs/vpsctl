import { AppError } from "../core/errors.ts";
import type { MachineOffer, MachineQuery, Provider } from "../core/provider.ts";
import type { CliCommand } from "./command.ts";
import type { CommandContext, CommonOptions } from "./context.ts";
import { render } from "./output.ts";
import { queryAllAccounts } from "./query.ts";

function summary(machine: MachineOffer): Omit<MachineOffer, "provider_id"> {
  const { provider_id: _, ...fields } = machine;
  return fields;
}

export async function listMachines(
  command: CliCommand,
  context: CommandContext,
  query: MachineQuery,
  all_accounts: boolean,
): Promise<void> {
  const flags = command.optsWithGlobals<CommonOptions>();
  const fetchMachines = (provider: Provider): Promise<MachineOffer[]> => {
    if (!provider.listMachines) {
      throw new AppError(
        "unsupported_operation",
        `Provider '${provider.info.id}' does not support machine discovery.`,
      );
    }
    return provider.listMachines(query);
  };
  if (!all_accounts) {
    await context.readProvider(
      command,
      "spec.list.machine",
      async (provider) => {
        const machines = await fetchMachines(provider);
        return flags.json ? machines : machines.map(summary);
      },
    );
    return;
  }
  const results = (await queryAllAccounts(command, context, fetchMachines)).map(
    (result) =>
      "data" in result
        ? {
            account_id: result.account_id,
            provider_id: result.provider_id,
            machines: result.data,
          }
        : result,
  );
  if (flags.json) {
    context.print(command, "spec.list.machine", results);
    return;
  }
  for (const result of results) {
    context.io.write_out(
      `Account: ${result.account_id} (${result.provider_id})\n`,
    );
    context.io.write_out(
      `${"machines" in result ? render(result.machines.map(summary)) : `Error: ${result.error}`}\n`,
    );
  }
  if (results.length === 0) {
    context.io.write_out("No accounts configured. Run 'auth login'.\n");
  }
}
