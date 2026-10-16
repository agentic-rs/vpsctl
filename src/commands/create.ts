import { AppError } from "../core/errors.ts";
import type {
  CreateGuidance,
  CreateInstanceInput,
  MachineOffer,
  MachineQuery,
  MachineType,
  Provider,
} from "../core/provider.ts";
import type { CliIO, PromptOption } from "./context.ts";
import { nonnegativeInteger, positiveInteger } from "./input.ts";
import { formatMoney, sanitizeTerminalText } from "./output.ts";

export interface CreateReview {
  machine: MachineOffer;
  cost_notice: string;
  image_name?: string;
}

const machine_type_labels: Record<MachineType, string> = {
  shared_cpu: "Shared CPU",
  dedicated_cpu: "Dedicated CPU",
  bare_metal: "Bare metal",
  gpu: "GPU",
};

function invalidSelection(): never {
  throw new AppError("invalid_input", "Choose one of the available options.");
}

async function choose(
  io: CliIO,
  message: string,
  options: PromptOption[],
): Promise<string> {
  if (!io.select) {
    throw new AppError(
      "invalid_input",
      "Guided creation requires interactive selection.",
    );
  }
  const value = await io.select(
    message,
    options.map((option) => ({
      ...option,
      label: sanitizeTerminalText(option.label),
      ...(option.hint === undefined
        ? {}
        : { hint: sanitizeTerminalText(option.hint) }),
    })),
  );
  if (!options.some((option) => option.value === value)) invalidSelection();
  return value;
}

function validateText(value: string): string | undefined {
  if (!value.trim()) return "A value is required.";
  if (/\p{C}/u.test(value)) return "Use text without control characters.";
  return undefined;
}

async function readValue(
  io: CliIO,
  message: string,
  initial_value?: string,
  validate: (value: string) => string | undefined = validateText,
): Promise<string> {
  if (!io.read_text) {
    throw new AppError(
      "invalid_input",
      "Guided creation requires interactive text input.",
    );
  }
  const value = (
    await io.read_text(message, {
      ...(initial_value === undefined ? {} : { initial_value }),
      validate,
    })
  ).trim();
  const error = validate(value);
  if (error !== undefined) throw new AppError("invalid_input", error);
  return value;
}

function validateInteger(
  parse: (value: string) => number,
): (value: string) => string | undefined {
  return (value) => {
    try {
      parse(value.trim());
      return undefined;
    } catch (error) {
      if (error instanceof AppError) return error.message;
      throw error;
    }
  };
}

function volumeSize(value: string): number {
  const size = nonnegativeInteger(value);
  if (size !== 0 && size < 10) {
    throw new AppError(
      "invalid_input",
      "Persistent storage must be zero or at least 10 GB.",
    );
  }
  return size;
}

function advertisedCost(machine: MachineOffer): string {
  const costs: string[] = [];
  if (
    machine.monthly_cost !== undefined &&
    Number.isFinite(machine.monthly_cost) &&
    machine.monthly_cost >= 0
  ) {
    costs.push(`${formatMoney(machine.monthly_cost, machine.currency)}/month`);
  }
  if (
    machine.hourly_cost !== undefined &&
    Number.isFinite(machine.hourly_cost) &&
    machine.hourly_cost >= 0
  ) {
    costs.push(`${formatMoney(machine.hourly_cost, machine.currency)}/hour`);
  }
  return costs.length > 0 ? costs.join("; ") : "Price unavailable";
}

function machineHardware(machine: MachineOffer): string {
  const fields: string[] = [];
  if (machine.gpu_name !== undefined) {
    fields.push(
      `${machine.gpu_count === undefined ? "" : `${machine.gpu_count} × `}${machine.gpu_name}`,
    );
  } else if (machine.gpu_count !== undefined) {
    fields.push(`${machine.gpu_count} GPU(s)`);
  }
  if (machine.gpu_memory_gb !== undefined) {
    fields.push(`${machine.gpu_memory_gb} GB GPU memory`);
  }
  if (machine.vcpu_count !== undefined) {
    fields.push(`${machine.vcpu_count} vCPU(s)`);
  }
  if (machine.memory_mb !== undefined) {
    fields.push(`${machine.memory_mb} MB RAM`);
  }
  if (machine.disk_gb !== undefined) {
    fields.push(`${machine.disk_gb} GB disk`);
  }
  return fields.join(", ");
}

async function chooseRegion(
  input: CreateInstanceInput,
  guidance: CreateGuidance,
  io: CliIO,
  provider: Provider,
): Promise<void> {
  if (input.region_id !== undefined || guidance.region === "none") return;
  const regions = await provider.listRegions();
  const options: PromptOption[] = regions.map((region) => ({
    value: region.id,
    label: region.name || region.id,
    hint: [region.id, region.country].filter(Boolean).join(" · "),
  }));
  if (guidance.region === "optional") {
    options.unshift({ value: "__any__", label: "Any available region" });
  }
  if (options.length === 0) {
    throw new AppError(
      "not_found",
      "No regions are available. Check the provider catalog and try again.",
    );
  }
  const region_id = await choose(io, "Choose a region", options);
  if (guidance.region === "optional" && region_id === "__any__") return;
  input.region_id = region_id;
}

async function configureGpu(
  input: CreateInstanceInput,
  guidance: CreateGuidance,
  io: CliIO,
): Promise<void> {
  if (guidance.gpu_count && input.gpu_count === undefined) {
    input.gpu_count = positiveInteger(
      await readValue(io, "GPU count", "1", validateInteger(positiveInteger)),
    );
  }
  if (guidance.disk_gb && input.disk_gb === undefined) {
    input.disk_gb = positiveInteger(
      await readValue(
        io,
        "Container disk size (GB)",
        "40",
        validateInteger(positiveInteger),
      ),
    );
  }
  if (guidance.volume_gb && input.volume_gb === undefined) {
    input.volume_gb = volumeSize(
      await readValue(
        io,
        "Persistent volume size (GB)",
        "0",
        validateInteger(volumeSize),
      ),
    );
  }
}

export async function prepareCreate(
  original: CreateInstanceInput,
  guidance: CreateGuidance,
  io: CliIO,
  provider: Provider,
): Promise<{ input: CreateInstanceInput; review: CreateReview }> {
  if (!provider.listMachines) {
    throw new AppError(
      "unsupported_operation",
      "This provider does not support guided machine discovery. Supply creation flags instead.",
    );
  }
  const input = { ...original };
  const machine_id =
    guidance.machine_source === "plan" ? input.plan_id : input.offer_id;
  let type: MachineType | undefined;
  if (guidance.machine_types.length === 1) {
    type = guidance.machine_types[0];
  } else if (machine_id === undefined) {
    const selected = await choose(
      io,
      "Choose a machine type",
      guidance.machine_types.map((value) => ({
        value,
        label: machine_type_labels[value],
      })),
    );
    type = guidance.machine_types.find((value) => value === selected);
  }
  await chooseRegion(input, guidance, io, provider);
  await configureGpu(input, guidance, io);
  const query: MachineQuery = {
    available_only: true,
    ...(type === undefined ? {} : { type }),
    ...(input.region_id === undefined ? {} : { region_id: input.region_id }),
    ...(machine_id === undefined ? {} : { id: machine_id }),
    ...(input.gpu_count === undefined ? {} : { gpu_count: input.gpu_count }),
    ...(guidance.machine_source !== "offer" || input.disk_gb === undefined
      ? {}
      : { disk_gb: input.disk_gb }),
  };
  const machines = (await provider.listMachines(query)).filter(
    (machine) =>
      machine.source === guidance.machine_source &&
      guidance.machine_types.includes(machine.type) &&
      (type === undefined || machine.type === type) &&
      machine.availability === "available" &&
      (machine_id === undefined || machine.id === machine_id) &&
      (input.region_id === undefined ||
        machine.region_ids.includes(input.region_id)) &&
      (input.gpu_count === undefined || machine.gpu_count === input.gpu_count),
  );
  if (machines.length === 0) {
    throw new AppError(
      "not_found",
      machine_id === undefined
        ? "No available machines match these choices. Try another region, machine type, or GPU count."
        : "The requested machine is unavailable for these choices. Check spec list machine or choose another region.",
    );
  }
  if (new Set(machines.map((machine) => machine.id)).size !== machines.length) {
    throw new AppError(
      "invalid_response",
      "The provider returned duplicate machine IDs. Check the catalog before creating an instance.",
    );
  }
  const selected_id =
    machine_id ??
    (await choose(
      io,
      "Choose a machine",
      machines.map((machine) => ({
        value: machine.id,
        label: machine.name ? `${machine.name} (${machine.id})` : machine.id,
        hint: [machineHardware(machine), advertisedCost(machine)]
          .filter(Boolean)
          .join(" · "),
      })),
    ));
  const machine = machines.find((item) => item.id === selected_id);
  if (machine === undefined) invalidSelection();
  if (guidance.machine_source === "plan") input.plan_id = machine.id;
  else input.offer_id = machine.id;
  let image_name: string | undefined;
  if (input.image_id === undefined) {
    if (guidance.image === "catalog") {
      const images = await provider.listImages();
      if (images.length === 0) {
        throw new AppError(
          "not_found",
          "No images are available. Check the provider image catalog and try again.",
        );
      }
      input.image_id = await choose(
        io,
        "Choose an image",
        images.map((image) => ({
          value: image.id,
          label: image.name || image.id,
          hint: [image.id, image.architecture].filter(Boolean).join(" · "),
        })),
      );
      image_name = images.find((image) => image.id === input.image_id)?.name;
    } else {
      input.image_id = await readValue(io, "Docker image");
    }
  }
  if (input.label === undefined) {
    input.label = await readValue(io, "Instance label", "vpsctl-instance");
  }
  return {
    input,
    review: {
      machine,
      cost_notice: guidance.cost_notice,
      ...(image_name === undefined ? {} : { image_name }),
    },
  };
}

export function formatCreateReview(
  account_name: string,
  provider_id: string,
  input: CreateInstanceInput,
  review: CreateReview,
): string {
  const { machine } = review;
  const lines = [
    `Account: ${account_name}`,
    `Provider: ${provider_id}`,
    `Machine: ${machine.name ? `${machine.name} (${machine.id})` : machine.id}`,
    `Type: ${machine_type_labels[machine.type]}`,
    `Region: ${input.region_id ?? "Provider selected"}`,
    `Image: ${review.image_name ? `${review.image_name} (${input.image_id})` : (input.image_id ?? "Unspecified")}`,
    `Label: ${input.label ?? "Unspecified"}`,
  ];
  const hardware = machineHardware(machine);
  if (hardware) lines.push(`Hardware: ${hardware}`);
  if (input.gpu_count !== undefined) {
    lines.push(`GPU count: ${input.gpu_count}`);
  }
  if (input.disk_gb !== undefined) {
    lines.push(`Container disk: ${input.disk_gb} GB`);
  }
  if (input.volume_gb !== undefined) {
    lines.push(`Persistent volume: ${input.volume_gb} GB`);
  }
  if (input.hostname !== undefined) {
    lines.push(`Hostname: ${input.hostname}`);
  }
  if (input.ssh_key_ids !== undefined) {
    lines.push(`SSH key IDs: ${JSON.stringify(input.ssh_key_ids)}`);
  }
  if (input.tags !== undefined) {
    lines.push(`Tags: ${JSON.stringify(input.tags)}`);
  }
  if (input.ports !== undefined) {
    lines.push(`Ports: ${JSON.stringify(input.ports)}`);
  }
  if (input.enable_ssh !== undefined) {
    lines.push(`SSH enabled: ${input.enable_ssh ? "yes" : "no"}`);
  }
  if (input.enable_ipv6 !== undefined) {
    lines.push(`IPv6 enabled: ${input.enable_ipv6 ? "yes" : "no"}`);
  }
  lines.push(`Advertised cost: ${advertisedCost(machine)}`, review.cost_notice);
  return lines.map(sanitizeTerminalText).join("\n");
}
