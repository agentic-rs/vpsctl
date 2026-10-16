import { AppError } from "../core/errors.ts";
import type { MachineOffer } from "../core/provider.ts";
import type { CliIO, PromptOption, PromptSelectOptions } from "./context.ts";
import { nonnegativeInteger } from "./input.ts";
import { formatMoney, sanitizeTerminalText } from "./output.ts";

export async function choose(
  io: CliIO,
  message: string,
  options: PromptOption[],
  prompt_options?: PromptSelectOptions,
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
    prompt_options,
  );
  if (!options.some((option) => option.value === value)) {
    throw new AppError("invalid_input", "Choose one of the available options.");
  }
  return value;
}

function validateText(value: string): string | undefined {
  if (!value.trim()) return "A value is required.";
  if (/\p{C}/u.test(value)) return "Use text without control characters.";
  return undefined;
}

export async function readValue(
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
  const safe_initial_value =
    initial_value !== undefined && !/\p{C}/u.test(initial_value)
      ? initial_value
      : undefined;
  const value = (
    await io.read_text(message, {
      ...(safe_initial_value === undefined
        ? {}
        : { initial_value: safe_initial_value }),
      validate,
    })
  ).trim();
  const error = validate(value);
  if (error !== undefined) throw new AppError("invalid_input", error);
  return value;
}

export function validateInteger(
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

export function volumeSize(value: string): number {
  const size = nonnegativeInteger(value);
  if (size !== 0 && size < 10) {
    throw new AppError(
      "invalid_input",
      "Persistent storage must be zero or at least 10 GB.",
    );
  }
  return size;
}

export function advertisedCost(machine: MachineOffer): string {
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

export function machineHardware(machine: MachineOffer): string {
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

export async function withProgress<Value>(
  io: CliIO,
  message: string,
  execute: () => Promise<Value>,
): Promise<Value> {
  const progress = io.progress?.(message);
  try {
    progress?.signal?.throwIfAborted();
    const result = await execute();
    progress?.signal?.throwIfAborted();
    progress?.stop("Catalog loaded.");
    return result;
  } catch (error) {
    progress?.fail("Catalog request failed.");
    throw error;
  }
}
