import type { CliCommand } from "./command.ts";
import type { CommandContext } from "./context.ts";

export function registerProviderCommands(
  program: CliCommand,
  context: CommandContext,
): void {
  const provider = program
    .command("provider")
    .description("Inspect registered providers");
  const list = provider
    .command("list")
    .description("List providers and capabilities");
  list.action(() =>
    context.print(
      list,
      "provider.list",
      context.registry.list().map(({ info, credential_fields }) => ({
        ...info,
        credential_fields,
      })),
    ),
  );
}
