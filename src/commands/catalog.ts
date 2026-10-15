import type { Provider } from "../core/provider.ts";
import type { CliCommand } from "./command.ts";
import type { CommandContext } from "./context.ts";

export function registerCatalogCommands(
  program: CliCommand,
  context: CommandContext,
): void {
  const { readProvider } = context;
  const catalog = program
    .command("catalog")
    .description("Discover regions, plans, OS images, and SSH keys");
  for (const [name, description, execute] of [
    ["regions", "List regions", (provider: Provider) => provider.listRegions()],
    [
      "images",
      "List operating system images",
      (provider: Provider) => provider.listImages(),
    ],
    [
      "ssh-keys",
      "List registered SSH keys",
      (provider: Provider) => provider.listSshKeys(),
    ],
  ] as const) {
    const command = catalog.command(name).description(description);
    command.action(() =>
      readProvider(command, `catalog.${name.replaceAll("-", "_")}`, execute),
    );
  }
  const plans = catalog
    .command("plans")
    .description(
      "List plans; region filter shows supported locations, not live stock",
    )
    .option("--region <id>", "Filter plans by region");
  plans.action(() =>
    readProvider(plans, "catalog.plans", (provider) =>
      provider.listPlans(plans.opts<{ region?: string }>().region),
    ),
  );
}
