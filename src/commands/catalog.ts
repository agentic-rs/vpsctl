import { AppError } from "../core/errors.ts";
import type { OfferQuery, Provider } from "../core/provider.ts";
import type { CliCommand } from "./command.ts";
import type { CommandContext } from "./context.ts";
import { nonblank, positiveInteger } from "./input.ts";

export function registerCatalogCommands(
  program: CliCommand,
  context: CommandContext,
): void {
  const { readProvider } = context;
  const catalog = program
    .command("catalog")
    .description("Discover regions, plans, GPU offers, images, and SSH keys");
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
    .description("List plans or GPU types; availability and prices can change")
    .option("--region <id>", "Filter plans by region");
  plans.action(() =>
    readProvider(plans, "catalog.plans", (provider) =>
      provider.listPlans(plans.opts<{ region?: string }>().region),
    ),
  );
  const offers = catalog
    .command("offers")
    .description("Search verified on-demand GPU rental offers")
    .option("--gpu <name>", "Exact GPU model name")
    .option("--gpu-count <count>", "Number of GPUs", positiveInteger)
    .option(
      "--disk-gb <size>",
      "Requested container disk size in GB",
      positiveInteger,
    )
    .option(
      "--limit <count>",
      "Maximum offers, up to 100 (default: 20)",
      positiveInteger,
    );
  offers.action(() => {
    const flags = offers.opts<{
      gpu?: string;
      gpu_count?: number;
      disk_gb?: number;
      limit?: number;
    }>();
    const query: OfferQuery = {
      ...(flags.gpu !== undefined
        ? { gpu_name: nonblank(flags.gpu, "GPU") }
        : {}),
      ...(flags.gpu_count !== undefined ? { gpu_count: flags.gpu_count } : {}),
      ...(flags.disk_gb !== undefined ? { disk_gb: flags.disk_gb } : {}),
      ...(flags.limit !== undefined ? { limit: flags.limit } : {}),
    };
    if (query.limit !== undefined && query.limit > 100) {
      throw new AppError("invalid_input", "Offer limit must be at most 100.");
    }
    return readProvider(offers, "catalog.offers", (provider) => {
      if (!provider.listOffers) {
        throw new AppError(
          "unsupported_operation",
          `Provider '${provider.info.id}' does not support rental offer search.`,
        );
      }
      return provider.listOffers(query);
    });
  });
}
