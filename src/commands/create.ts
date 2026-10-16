import { AppError } from "../core/errors.ts";
import { filterMachines } from "../core/machines.ts";
import type {
  CreateGuidance,
  CreateInstanceInput,
  MachineOffer,
  MachineQuery,
  Provider,
} from "../core/provider.ts";
import type { CliIO, PromptOption } from "./context.ts";
import {
  advertisedCost,
  choose,
  machineHardware,
  readValue,
  validateInteger,
  volumeSize,
  withProgress,
} from "./create-prompts.ts";
import {
  type CreateRequirements,
  cancelCreation,
  editRequirements,
  initialRequirements,
  machine_type_labels,
} from "./create-requirements.ts";
import { positiveInteger } from "./input.ts";
import { sanitizeTerminalText } from "./output.ts";

export interface CreateReview {
  machine: MachineOffer;
  cost_notice: string;
  image_name?: string;
}

export interface CreateWizardOptions {
  account_name: string;
  notice: string;
  dry_run: boolean;
  validate_input?(input: CreateInstanceInput): void;
}

function costOrder(machine: MachineOffer): { group: string; amount: number } {
  for (const [period, amount] of [
    ["month", machine.monthly_cost],
    ["hour", machine.hourly_cost],
  ] as const) {
    if (amount !== undefined && Number.isFinite(amount) && amount >= 0) {
      return { group: `${machine.currency}:${period}`, amount };
    }
  }
  return { group: "", amount: Number.POSITIVE_INFINITY };
}

function compareMachines(left: MachineOffer, right: MachineOffer): number {
  const a = costOrder(left);
  const b = costOrder(right);
  if (!a.group && b.group) return 1;
  if (a.group && !b.group) return -1;
  return (
    a.group.localeCompare(b.group) ||
    a.amount - b.amount ||
    left.id.localeCompare(right.id)
  );
}

async function discoverMachines(
  input: CreateInstanceInput,
  requirements: CreateRequirements,
  guidance: CreateGuidance,
  io: CliIO,
  provider: Provider,
  machine_id?: string,
): Promise<MachineOffer[]> {
  const listMachines = provider.listMachines?.bind(provider);
  if (!listMachines) {
    throw new AppError(
      "unsupported_operation",
      "This provider does not support guided machine discovery. Supply creation flags instead.",
    );
  }
  const query: MachineQuery = {
    available_only: true,
    ...(requirements.type === undefined ? {} : { type: requirements.type }),
    ...(input.region_id === undefined ? {} : { region_id: input.region_id }),
    ...(machine_id === undefined ? {} : { id: machine_id }),
    ...(input.gpu_count === undefined ? {} : { gpu_count: input.gpu_count }),
    ...(guidance.machine_source !== "offer" || input.disk_gb === undefined
      ? {}
      : { disk_gb: input.disk_gb }),
    ...(requirements.min_vcpu ? { min_vcpu: requirements.min_vcpu } : {}),
    ...(requirements.min_memory_gb
      ? { min_memory_gb: requirements.min_memory_gb }
      : {}),
    ...(requirements.min_gpu_memory_gb
      ? { min_gpu_memory_gb: requirements.min_gpu_memory_gb }
      : {}),
  };
  const catalog = await withProgress(io, "Finding matching machines", () =>
    listMachines(query),
  );
  const machines = filterMachines(
    catalog.filter(
      (machine) =>
        machine.source === guidance.machine_source &&
        guidance.machine_types.includes(machine.type),
    ),
    query,
  );
  if (new Set(machines.map((machine) => machine.id)).size !== machines.length) {
    throw new AppError(
      "invalid_response",
      "The provider returned duplicate machine IDs. Check the catalog before creating an instance.",
    );
  }
  return machines.sort(compareMachines);
}

async function chooseMachine(
  io: CliIO,
  machines: MachineOffer[],
): Promise<MachineOffer | undefined> {
  let back = "__back__";
  while (machines.some((machine) => machine.id === back)) back += "_";
  const selected = await choose(
    io,
    "Choose a machine",
    [
      ...machines.map((machine) => ({
        value: machine.id,
        label: `${machine.name ? `${machine.name} (${machine.id})` : machine.id} · ${advertisedCost(machine)}`,
        hint: machineHardware(machine),
      })),
      { value: back, label: "Back to requirements" },
    ],
    { searchable: true },
  );
  return selected === back
    ? undefined
    : machines.find((machine) => machine.id === selected);
}

async function configureImage(
  input: CreateInstanceInput,
  guidance: CreateGuidance,
  io: CliIO,
  provider: Provider,
): Promise<string | undefined> {
  if (guidance.image === "docker") {
    io.write_err("Enter a Docker image reference (repository/image:tag).\n");
    input.image_id = await readValue(io, "Docker image", input.image_id);
    return undefined;
  }
  const images = await withProgress(io, "Loading images", () =>
    provider.listImages(),
  );
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
    {
      searchable: true,
      ...(input.image_id === undefined
        ? {}
        : { initial_value: input.image_id }),
    },
  );
  return images.find((image) => image.id === input.image_id)?.name;
}

async function configureStorage(
  input: CreateInstanceInput,
  field: "disk_gb" | "volume_gb",
  io: CliIO,
): Promise<void> {
  const volume = field === "volume_gb";
  const parse = volume ? volumeSize : positiveInteger;
  input[field] = parse(
    await readValue(
      io,
      volume ? "Persistent volume size (GB)" : "Container disk size (GB)",
      String(input[field] ?? (volume ? 0 : 40)),
      validateInteger(parse),
    ),
  );
}

async function fillConfiguration(
  input: CreateInstanceInput,
  guidance: CreateGuidance,
  io: CliIO,
  provider: Provider,
  review: CreateReview,
): Promise<void> {
  if (
    guidance.machine_source === "plan" &&
    guidance.disk_gb &&
    input.disk_gb === undefined
  )
    await configureStorage(input, "disk_gb", io);
  if (guidance.volume_gb && input.volume_gb === undefined)
    await configureStorage(input, "volume_gb", io);
  if (input.image_id === undefined) {
    const name = await configureImage(input, guidance, io, provider);
    if (name !== undefined) review.image_name = name;
  }
  if (input.label === undefined)
    input.label = await readValue(io, "Instance label", "vpsctl-instance");
}

async function editConfiguration(
  input: CreateInstanceInput,
  guidance: CreateGuidance,
  io: CliIO,
  provider: Provider,
  review: CreateReview,
): Promise<"review" | "machine"> {
  for (;;) {
    const choices: PromptOption[] = [
      { value: "done", label: "Return to review" },
      {
        value: "image_id",
        label: "Change image",
        ...(input.image_id === undefined ? {} : { hint: input.image_id }),
      },
      {
        value: "label",
        label: "Change instance label",
        ...(input.label === undefined ? {} : { hint: input.label }),
      },
      ...(guidance.machine_source === "plan" && guidance.disk_gb
        ? [
            {
              value: "disk_gb",
              label: "Change container disk size",
              hint: `${input.disk_gb} GB`,
            },
          ]
        : []),
      ...(guidance.volume_gb
        ? [
            {
              value: "volume_gb",
              label: "Change persistent volume size",
              hint: `${input.volume_gb} GB`,
            },
          ]
        : []),
      { value: "machine", label: "Back to machines" },
    ];
    const action = await choose(io, "Edit configuration", choices);
    switch (action) {
      case "done":
        return "review";
      case "machine":
        return "machine";
      case "image_id": {
        const name = await configureImage(input, guidance, io, provider);
        if (name === undefined) delete review.image_name;
        else review.image_name = name;
        break;
      }
      case "label":
        input.label = await readValue(io, "Instance label", input.label);
        break;
      case "disk_gb":
      case "volume_gb":
        await configureStorage(input, action, io);
        break;
    }
  }
}

export async function prepareCreate(
  original: CreateInstanceInput,
  guidance: CreateGuidance,
  io: CliIO,
  provider: Provider,
  options: CreateWizardOptions,
): Promise<{ input: CreateInstanceInput; review: CreateReview }> {
  const input = { ...original };
  let requested_machine_id =
    guidance.machine_source === "plan" ? input.plan_id : input.offer_id;
  const requirements = await initialRequirements(input, guidance, io, provider);
  let edit_requirements = requested_machine_id === undefined;
  let machines: MachineOffer[] | undefined;
  let machine: MachineOffer | undefined;
  let review: CreateReview | undefined;
  const resetMachine = (): void => {
    requested_machine_id = undefined;
    delete input.plan_id;
    delete input.offer_id;
    machine = undefined;
  };
  for (;;) {
    if (edit_requirements) {
      await editRequirements(requirements, input, guidance, io, provider);
      machines = undefined;
      machine = undefined;
      edit_requirements = false;
    }
    machines ??= await discoverMachines(
      input,
      requirements,
      guidance,
      io,
      provider,
      requested_machine_id,
    );
    if (machines.length === 0) {
      if (requested_machine_id !== undefined) {
        throw new AppError(
          "not_found",
          "The requested machine is unavailable for these choices. Check spec list machine or choose another region.",
        );
      }
      const message =
        "No available machines match these requirements. Change the region, machine type, sizing, or minimum specifications.";
      if (io.note) io.note(message, "No matching machines");
      else io.write_err(`${message}\n`);
      const action = await choose(io, "No matching machines", [
        { value: "requirements", label: "Change requirements" },
        { value: "cancel", label: "Cancel" },
      ]);
      if (action === "cancel") cancelCreation();
      edit_requirements = true;
      continue;
    }
    machine ??=
      requested_machine_id === undefined
        ? await chooseMachine(io, machines)
        : machines.find((item) => item.id === requested_machine_id);
    if (machine === undefined) {
      edit_requirements = true;
      continue;
    }
    requirements.type ??= machine.type;
    if (guidance.machine_source === "plan") input.plan_id = machine.id;
    else input.offer_id = machine.id;
    review = {
      machine,
      cost_notice: guidance.cost_notice,
      ...(review?.image_name === undefined
        ? {}
        : { image_name: review.image_name }),
    };
    await fillConfiguration(input, guidance, io, provider, review);
    for (;;) {
      options.validate_input?.(input);
      const text = [
        formatCreateReview(
          options.account_name,
          provider.info.id,
          input,
          review,
        ),
        options.notice,
        ...(options.dry_run ? ["Dry run: no instance will be created."] : []),
      ]
        .filter(Boolean)
        .join("\n");
      if (io.note)
        io.note(
          text,
          options.dry_run
            ? "Dry-run instance creation"
            : "Review instance creation",
        );
      else io.write_err(`${text}\n`);
      const action = await choose(io, "What next?", [
        {
          value: "continue",
          label: options.dry_run
            ? "Finish dry run"
            : "Continue to confirmation",
        },
        { value: "requirements", label: "Change requirements" },
        { value: "machine", label: "Choose another machine" },
        { value: "configuration", label: "Edit configuration" },
        { value: "cancel", label: "Cancel" },
      ]);
      if (action === "continue") return { input, review };
      if (action === "cancel") cancelCreation();
      if (action === "configuration") {
        if (
          (await editConfiguration(input, guidance, io, provider, review)) ===
          "review"
        )
          continue;
      }
      if (action === "requirements") {
        resetMachine();
        machines = undefined;
        edit_requirements = true;
      } else {
        if (requested_machine_id !== undefined) machines = undefined;
        resetMachine();
      }
      break;
    }
  }
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
