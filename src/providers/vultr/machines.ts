import { z } from "zod";
import type { MachineOffer, MachineType } from "../../core/provider.ts";
import { plan_schema } from "./schemas.ts";

export const machine_plan_schema = plan_schema.extend({
  name: z.string().optional(),
  type: z.string().optional(),
  gpu_type: z.string().nullish(),
  gpu_vram_gb: z.number().nonnegative().nullish(),
});

export const metal_plan_schema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  cpu_count: z.number().int().nonnegative(),
  cpu_threads: z.number().int().nonnegative(),
  cpu_model: z.string(),
  ram: z.number().nonnegative(),
  disk: z.union([
    z.number().nonnegative(),
    z
      .string()
      .regex(/^\d+$/)
      .transform(Number)
      .pipe(z.number().int().nonnegative().safe()),
  ]),
  disk_count: z.number().int().positive().optional(),
  monthly_cost: z.number().nonnegative(),
  locations: z.array(z.string()).optional().default([]),
});

export const availability_schema = z.object({
  available_plans: z.array(z.string().min(1)),
});

function machineType(type: string | undefined): MachineType | undefined {
  switch (type) {
    case "vc2":
    case "vhf":
    case "vhp":
      return "shared_cpu";
    case "vdc":
    case "voc":
    case "voc-g":
    case "voc-c":
    case "voc-m":
    case "voc-s":
    case "vx1":
      return "dedicated_cpu";
    case "vcg":
      return "gpu";
    default:
      return undefined;
  }
}

export function normalizeMachinePlan(
  value: z.infer<typeof machine_plan_schema>,
): MachineOffer | undefined {
  const type = machineType(value.type);
  if (type === undefined) return undefined;
  return {
    provider_id: "vultr",
    id: value.id,
    ...(value.name === undefined ? {} : { name: value.name }),
    type,
    source: "plan",
    availability: "unknown",
    region_ids: value.locations,
    vcpu_count: value.vcpu_count,
    memory_mb: value.ram,
    disk_gb: value.disk,
    monthly_cost: value.monthly_cost,
    currency: "USD",
    ...(type === "gpu" && value.gpu_type ? { gpu_name: value.gpu_type } : {}),
    ...(type === "gpu" && value.gpu_vram_gb != null
      ? { gpu_memory_gb: value.gpu_vram_gb }
      : {}),
  };
}

export function normalizeMetalPlan(
  value: z.infer<typeof metal_plan_schema>,
): MachineOffer {
  return {
    provider_id: "vultr",
    id: value.id,
    name: value.name ?? value.cpu_model,
    type: "bare_metal",
    source: "plan",
    availability: "unknown",
    region_ids: value.locations,
    cpu_count: value.cpu_count,
    cpu_threads: value.cpu_threads,
    cpu_model: value.cpu_model,
    memory_mb: value.ram,
    ...(value.disk_count === 1 ? { disk_gb: value.disk } : {}),
    disk_size_gb: value.disk,
    ...(value.disk_count === undefined ? {} : { disk_count: value.disk_count }),
    monthly_cost: value.monthly_cost,
    currency: "USD",
  };
}
