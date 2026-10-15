import { Argument } from "commander";
import { AppError } from "../core/errors.ts";
import type { OfferQuery } from "../core/provider.ts";
import type { CliCommand } from "./command.ts";
import type { CommandContext } from "./context.ts";
import { nonblank, positiveInteger } from "./input.ts";

export function registerSpecCommands(
  program: CliCommand,
  context: CommandContext,
): void {
  const spec = program
    .command("spec")
    .description("Inspect remote provider specifications and GPU offers");
  const list = spec
    .command("list")
    .description("List specifications for the selected provider account")
    .addArgument(
      new Argument("<resource>", "Specification resource").choices([
        "region",
        "plan",
        "image",
        "offer",
      ]),
    )
    .option("--region <id>", "Filter plans by region")
    .option("--gpu <name>", "Filter offers by exact GPU model name")
    .option(
      "--gpu-count <count>",
      "Filter offers by number of GPUs",
      positiveInteger,
    )
    .option(
      "--disk-gb <size>",
      "Requested offer disk size in GB",
      positiveInteger,
    )
    .option(
      "--limit <count>",
      "Maximum offers, up to 100 (default: 20)",
      positiveInteger,
    );
  list.action(async (resource: string) => {
    const flags = list.opts<{
      region?: string;
      gpu?: string;
      gpu_count?: number;
      disk_gb?: number;
      limit?: number;
    }>();
    if (flags.region !== undefined && resource !== "plan") {
      throw new AppError(
        "invalid_input",
        "--region applies only to spec list plan.",
      );
    }
    if (
      resource !== "offer" &&
      [flags.gpu, flags.gpu_count, flags.disk_gb, flags.limit].some(
        (value) => value !== undefined,
      )
    ) {
      throw new AppError(
        "invalid_input",
        "--gpu, --gpu-count, --disk-gb, and --limit apply only to spec list offer.",
      );
    }
    if (flags.limit !== undefined && flags.limit > 100) {
      throw new AppError("invalid_input", "Offer limit must be at most 100.");
    }
    const region_id =
      flags.region === undefined ? undefined : nonblank(flags.region, "Region");
    const query: OfferQuery = {
      ...(flags.gpu === undefined
        ? {}
        : { gpu_name: nonblank(flags.gpu, "GPU") }),
      ...(flags.gpu_count === undefined ? {} : { gpu_count: flags.gpu_count }),
      ...(flags.disk_gb === undefined ? {} : { disk_gb: flags.disk_gb }),
      ...(flags.limit === undefined ? {} : { limit: flags.limit }),
    };
    await context.readProvider(list, `spec.list.${resource}`, (provider) => {
      switch (resource) {
        case "region":
          return provider.listRegions();
        case "plan":
          return provider.listPlans(region_id);
        case "image":
          return provider.listImages();
        case "offer":
          if (!provider.listOffers) {
            throw new AppError(
              "unsupported_operation",
              `Provider '${provider.info.id}' does not support rental offer discovery.`,
            );
          }
          return provider.listOffers(query);
        default:
          throw new AppError(
            "invalid_input",
            "Unknown specification resource.",
          );
      }
    });
  });
}
