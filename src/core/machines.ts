import { z } from "zod";
import { AppError } from "./errors.ts";
import type { MachineOffer, MachineQuery } from "./provider.ts";

const machine_query_schema = z
  .object({
    id: z.string().trim().min(1).optional(),
    type: z
      .enum(["shared_cpu", "dedicated_cpu", "bare_metal", "gpu"])
      .optional(),
    region_id: z.string().trim().min(1).optional(),
    gpu_name: z.string().trim().min(1).optional(),
    gpu_count: z.number().int().positive().safe().optional(),
    disk_gb: z.number().int().positive().safe().optional(),
    min_vcpu: z.number().int().positive().safe().optional(),
    min_memory_gb: z.number().int().positive().safe().optional(),
    min_gpu_memory_gb: z.number().int().positive().safe().optional(),
    limit: z.number().int().positive().max(100).optional(),
    available_only: z.boolean().optional(),
  })
  .strict();

export function validateMachineQuery(query: MachineQuery = {}): MachineQuery {
  const result = machine_query_schema.safeParse(query);
  if (!result.success) {
    throw new AppError("invalid_input", "Invalid machine discovery filters.");
  }
  const filters = result.data;
  if (
    filters.type !== undefined &&
    filters.type !== "gpu" &&
    (filters.gpu_name !== undefined ||
      filters.gpu_count !== undefined ||
      filters.min_gpu_memory_gb !== undefined)
  ) {
    throw new AppError(
      "invalid_input",
      "GPU filters require --type gpu or no type filter.",
    );
  }
  return Object.fromEntries(
    Object.entries(filters).filter(([, value]) => value !== undefined),
  ) as MachineQuery;
}

export function filterMachines(
  machines: MachineOffer[],
  query: MachineQuery,
): MachineOffer[] {
  const filtered = machines.filter((machine) => {
    if (query.id !== undefined && machine.id !== query.id) return false;
    if (query.type !== undefined && machine.type !== query.type) return false;
    if (
      query.region_id !== undefined &&
      !machine.region_ids.includes(query.region_id)
    )
      return false;
    if (query.gpu_name !== undefined && machine.gpu_name !== query.gpu_name) {
      return false;
    }
    if (
      query.gpu_count !== undefined &&
      machine.gpu_count !== query.gpu_count
    ) {
      return false;
    }
    if (
      query.disk_gb !== undefined &&
      (machine.disk_gb === undefined || machine.disk_gb < query.disk_gb)
    )
      return false;
    if (
      query.min_vcpu !== undefined &&
      (machine.vcpu_count === undefined ||
        !Number.isFinite(machine.vcpu_count) ||
        machine.vcpu_count < query.min_vcpu)
    )
      return false;
    if (
      query.min_memory_gb !== undefined &&
      (machine.memory_mb === undefined ||
        !Number.isFinite(machine.memory_mb) ||
        machine.memory_mb / 1024 < query.min_memory_gb)
    )
      return false;
    if (
      query.min_gpu_memory_gb !== undefined &&
      (machine.gpu_memory_gb === undefined ||
        !Number.isFinite(machine.gpu_memory_gb) ||
        machine.gpu_memory_gb < query.min_gpu_memory_gb)
    )
      return false;
    return !query.available_only || machine.availability === "available";
  });
  return query.limit === undefined ? filtered : filtered.slice(0, query.limit);
}
