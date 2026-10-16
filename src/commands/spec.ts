import { Argument, Option } from "commander";
import { AppError } from "../core/errors.ts";
import { validateMachineQuery } from "../core/machines.ts";
import type { MachineType, OfferQuery } from "../core/provider.ts";
import type { CliCommand } from "./command.ts";
import type { CommandContext } from "./context.ts";
import { nonblank, positiveInteger } from "./input.ts";
import { listMachines } from "./machines.ts";

export function registerSpecCommands(
  program: CliCommand,
  context: CommandContext,
): void {
  const spec = program
    .command("spec")
    .description("Inspect remote provider specifications and rental machines");
  const list = spec
    .command("list")
    .description("List specifications for the selected provider account")
    .addArgument(
      new Argument("<resource>", "Specification resource").choices([
        "region",
        "plan",
        "image",
        "offer",
        "machine",
      ]),
    )
    .option("--region <id>", "Filter plans or machines by provider region")
    .addOption(
      new Option("--type <type>", "Machine category").choices([
        "shared-cpu",
        "dedicated-cpu",
        "bare-metal",
        "gpu",
      ]),
    )
    .option("--available", "Only machines with provider-reported capacity")
    .option(
      "--all, --all-accounts",
      "Query machines across configured accounts",
    )
    .option("--gpu <name>", "Filter offers or machines by exact GPU model")
    .option(
      "--gpu-count <count>",
      "Filter offers or machines by number of GPUs",
      positiveInteger,
    )
    .option(
      "--disk-gb <size>",
      "Minimum machine disk or requested offer disk size in GB",
      positiveInteger,
    )
    .option(
      "--limit <count>",
      "Maximum results, up to 100 (Vast.ai default: 20)",
      positiveInteger,
    );
  list.action(async (resource: string) => {
    const flags = list.opts<{
      region?: string;
      gpu?: string;
      gpu_count?: number;
      disk_gb?: number;
      limit?: number;
      type?: "shared-cpu" | "dedicated-cpu" | "bare-metal" | "gpu";
      available?: boolean;
      all_accounts?: boolean;
    }>();
    if (
      flags.region !== undefined &&
      resource !== "plan" &&
      resource !== "machine"
    ) {
      throw new AppError(
        "invalid_input",
        "--region applies only to spec list plan or machine.",
      );
    }
    if (
      resource !== "offer" &&
      resource !== "machine" &&
      [flags.gpu, flags.gpu_count, flags.disk_gb, flags.limit].some(
        (value) => value !== undefined,
      )
    ) {
      throw new AppError(
        "invalid_input",
        "--gpu, --gpu-count, --disk-gb, and --limit apply only to spec list offer or machine.",
      );
    }
    if (
      resource !== "machine" &&
      [flags.type, flags.available, flags.all_accounts].some(
        (value) => value !== undefined,
      )
    ) {
      throw new AppError(
        "invalid_input",
        "--type, --available, and --all apply only to spec list machine.",
      );
    }
    if (flags.limit !== undefined && flags.limit > 100) {
      throw new AppError("invalid_input", "Result limit must be at most 100.");
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
    if (resource === "machine") {
      const types: Record<NonNullable<typeof flags.type>, MachineType> = {
        "shared-cpu": "shared_cpu",
        "dedicated-cpu": "dedicated_cpu",
        "bare-metal": "bare_metal",
        gpu: "gpu",
      };
      await listMachines(
        list,
        context,
        validateMachineQuery({
          ...query,
          ...(region_id === undefined ? {} : { region_id }),
          ...(flags.type === undefined ? {} : { type: types[flags.type] }),
          ...(flags.available === undefined
            ? {}
            : { available_only: flags.available }),
        }),
        flags.all_accounts ?? false,
      );
      return;
    }
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
