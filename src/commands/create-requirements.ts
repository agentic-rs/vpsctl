import { AppError } from "../core/errors.ts";
import type {
  CreateGuidance,
  CreateInstanceInput,
  MachineType,
  Provider,
} from "../core/provider.ts";
import type { CliIO } from "./context.ts";
import {
  choose,
  readValue,
  validateInteger,
  withProgress,
} from "./create-prompts.ts";
import { nonnegativeInteger, positiveInteger } from "./input.ts";
import { sanitizeTerminalText } from "./output.ts";

export const machine_type_labels: Record<MachineType, string> = {
  shared_cpu: "Shared CPU",
  dedicated_cpu: "Dedicated CPU",
  bare_metal: "Bare metal",
  gpu: "GPU",
};

export interface CreateRequirements {
  type?: MachineType;
  min_vcpu: number;
  min_memory_gb: number;
  min_gpu_memory_gb: number;
}

export function cancelCreation(): never {
  throw new AppError("cancelled", "Operation cancelled.");
}

async function chooseType(
  requirements: CreateRequirements,
  guidance: CreateGuidance,
  io: CliIO,
): Promise<void> {
  const selected = await choose(
    io,
    "Choose a machine type",
    guidance.machine_types.map((value) => ({
      value,
      label: machine_type_labels[value],
    })),
    requirements.type === undefined ? {} : { initial_value: requirements.type },
  );
  const type = guidance.machine_types.find((value) => value === selected);
  if (type === undefined) {
    throw new AppError("invalid_input", "Choose one of the available options.");
  }
  requirements.type = type;
  if (requirements.type !== "gpu") requirements.min_gpu_memory_gb = 0;
}

async function chooseRegion(
  input: CreateInstanceInput,
  guidance: CreateGuidance,
  io: CliIO,
  provider: Provider,
): Promise<void> {
  const regions = await withProgress(io, "Loading regions", () =>
    provider.listRegions(),
  );
  // Use an unused value so a provider region ID cannot become a navigation action.
  let any_region = "__any__";
  while (regions.some((region) => region.id === any_region)) any_region += "_";
  const options = regions.map((region) => ({
    value: region.id,
    label: region.name || region.id,
    hint: [region.id, region.country].filter(Boolean).join(" · "),
  }));
  if (guidance.region === "optional") {
    options.unshift({
      value: any_region,
      label: "Any available region",
      hint: "Provider selected",
    });
  }
  if (options.length === 0) {
    throw new AppError(
      "not_found",
      "No regions are available. Check the provider catalog and try again.",
    );
  }
  const selected = await choose(io, "Choose a region", options, {
    searchable: true,
    ...(input.region_id === undefined
      ? {}
      : { initial_value: input.region_id }),
  });
  if (guidance.region === "optional" && selected === any_region)
    delete input.region_id;
  else input.region_id = selected;
}

async function readSize(
  io: CliIO,
  message: string,
  value: number,
): Promise<number> {
  return positiveInteger(
    await readValue(
      io,
      message,
      String(value),
      validateInteger(positiveInteger),
    ),
  );
}

export async function initialRequirements(
  input: CreateInstanceInput,
  guidance: CreateGuidance,
  io: CliIO,
  provider: Provider,
): Promise<CreateRequirements> {
  const requirements: CreateRequirements = {
    min_vcpu: 0,
    min_memory_gb: 0,
    min_gpu_memory_gb: 0,
    ...(guidance.machine_types.length === 1
      ? { type: guidance.machine_types[0] }
      : {}),
  };
  if (
    requirements.type === undefined &&
    input.plan_id === undefined &&
    input.offer_id === undefined
  ) {
    await chooseType(requirements, guidance, io);
  }
  if (guidance.region !== "none" && input.region_id === undefined) {
    await chooseRegion(input, guidance, io, provider);
  }
  if (guidance.gpu_count && input.gpu_count === undefined) {
    input.gpu_count = await readSize(io, "GPU count", 1);
  }
  // Vast prices offers for the requested allocation. RunPod storage is configured
  // after hardware selection because its catalog quotes compute separately.
  if (
    guidance.machine_source === "offer" &&
    guidance.disk_gb &&
    input.disk_gb === undefined
  ) {
    input.disk_gb = await readSize(io, "Container disk size (GB)", 40);
  }
  return requirements;
}

export async function editRequirements(
  requirements: CreateRequirements,
  input: CreateInstanceInput,
  guidance: CreateGuidance,
  io: CliIO,
  provider: Provider,
): Promise<void> {
  for (;;) {
    const lines = [
      `Machine type: ${requirements.type ? machine_type_labels[requirements.type] : "Specified machine"}`,
      ...(guidance.region === "none"
        ? []
        : [`Region: ${input.region_id ?? "Any available region"}`]),
      ...(input.gpu_count === undefined
        ? []
        : [`GPU count: ${input.gpu_count}`]),
      ...(guidance.machine_source !== "offer"
        ? []
        : [`Container disk: ${input.disk_gb} GB`]),
      `Minimum vCPUs: ${requirements.min_vcpu || "Any"}`,
      `Minimum RAM: ${requirements.min_memory_gb ? `${requirements.min_memory_gb} GB` : "Any"}`,
      ...(requirements.type !== "gpu"
        ? []
        : [
            `Minimum GPU memory: ${requirements.min_gpu_memory_gb ? `${requirements.min_gpu_memory_gb} GB` : "Any"}`,
          ]),
    ]
      .map(sanitizeTerminalText)
      .join("\n");
    if (io.note) io.note(lines, "Requirements");
    else io.write_err(`${lines}\n`);
    const action = await choose(io, "Requirements", [
      { value: "compare", label: "Compare matching machines" },
      ...(guidance.machine_types.length <= 1
        ? []
        : [{ value: "type", label: "Change machine type" }]),
      ...(guidance.region === "none"
        ? []
        : [{ value: "region", label: "Change region" }]),
      ...(guidance.gpu_count
        ? [{ value: "gpu_count", label: "Change GPU count" }]
        : []),
      ...(guidance.machine_source === "offer" && guidance.disk_gb
        ? [{ value: "disk_gb", label: "Change container disk size" }]
        : []),
      { value: "min_vcpu", label: "Set minimum vCPUs", hint: "0 means any" },
      { value: "min_memory_gb", label: "Set minimum RAM", hint: "0 means any" },
      ...(requirements.type !== "gpu"
        ? []
        : [
            {
              value: "min_gpu_memory_gb",
              label: "Set minimum GPU memory",
              hint: "0 means any",
            },
          ]),
      { value: "cancel", label: "Cancel" },
    ]);
    switch (action) {
      case "compare":
        return;
      case "cancel":
        return cancelCreation();
      case "type":
        await chooseType(requirements, guidance, io);
        break;
      case "region":
        await chooseRegion(input, guidance, io, provider);
        break;
      case "gpu_count":
        input.gpu_count = await readSize(io, "GPU count", input.gpu_count ?? 1);
        break;
      case "disk_gb":
        input.disk_gb = await readSize(
          io,
          "Container disk size (GB)",
          input.disk_gb ?? 40,
        );
        break;
      case "min_vcpu":
      case "min_memory_gb":
      case "min_gpu_memory_gb": {
        const messages = {
          min_vcpu: "Minimum vCPUs",
          min_memory_gb: "Minimum RAM (GB)",
          min_gpu_memory_gb: "Minimum GPU memory (GB)",
        };
        requirements[action] = nonnegativeInteger(
          await readValue(
            io,
            messages[action],
            String(requirements[action]),
            validateInteger(nonnegativeInteger),
          ),
        );
        break;
      }
    }
  }
}
