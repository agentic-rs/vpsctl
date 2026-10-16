import { z } from "zod";
import { AppError } from "./errors.ts";
import type { MachineOffer, MachineQuery } from "./provider.ts";

const machine_query_schema = z
  .object({
    type: z
      .enum(["shared_cpu", "dedicated_cpu", "bare_metal", "gpu"])
      .optional(),
    region_id: z.string().trim().min(1).optional(),
    gpu_name: z.string().trim().min(1).optional(),
    gpu_count: z.number().int().positive().safe().optional(),
    disk_gb: z.number().int().positive().safe().optional(),
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
    (filters.gpu_name !== undefined || filters.gpu_count !== undefined)
  ) {
    throw new AppError(
      "invalid_input",
      "--gpu and --gpu-count require --type gpu or no type filter.",
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
    return !query.available_only || machine.availability === "available";
  });
  return query.limit === undefined ? filtered : filtered.slice(0, query.limit);
}
