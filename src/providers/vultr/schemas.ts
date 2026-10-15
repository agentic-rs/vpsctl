import { z } from "zod";
import { AppError } from "../../core/errors.ts";
import type {
  CreateInstanceInput,
  EditInstanceInput,
  Image,
  Instance,
  InstanceStatus,
  Plan,
  Region,
  SshKey,
} from "../../core/provider.ts";

export const identifier_schema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
  .refine((value) => !value.includes(".."));

const image_id_schema = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .refine((value) => Number.isSafeInteger(Number(value)));

const create_schema = z.strictObject({
  region_id: identifier_schema,
  plan_id: identifier_schema,
  image_id: image_id_schema,
  label: z.string().optional(),
  hostname: z.string().optional(),
  ssh_key_ids: z.array(identifier_schema).optional(),
  tags: z.array(z.string()).optional(),
  enable_ipv6: z.boolean().optional(),
});

const edit_schema = z
  .strictObject({
    label: z.string().optional(),
    tags: z.array(z.string()).optional(),
    plan_id: identifier_schema.optional(),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined));

export const instance_schema = z.object({
  id: z.string().min(1),
  label: z.string().optional().default(""),
  region: z.string(),
  plan: z.string(),
  os_id: z.number().int().nonnegative(),
  status: z.string(),
  power_status: z.string(),
  server_status: z.string(),
  main_ip: z.string().optional().default(""),
  v6_main_ip: z.string().optional().default(""),
  tags: z.array(z.string()).optional().default([]),
});

export const region_schema = z.object({
  id: z.string().min(1),
  city: z.string(),
  country: z.string(),
});

export const plan_schema = z.object({
  id: z.string().min(1),
  vcpu_count: z.number().int().nonnegative(),
  ram: z.number().nonnegative(),
  disk: z.number().nonnegative(),
  monthly_cost: z.number().nonnegative(),
  locations: z.array(z.string()).optional().default([]),
});

export const image_schema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  arch: z.string(),
  family: z.string(),
});

export const ssh_key_schema = z.object({
  id: z.string().min(1),
  name: z.string(),
});

export const pagination_schema = z.object({
  meta: z
    .object({
      links: z.object({ next: z.string().nullable().optional() }).optional(),
    })
    .optional(),
});

export function validateInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const fields = [
      ...new Set(
        result.error.issues.map((issue) => issue.path.join(".") || "input"),
      ),
    ];
    throw new AppError(
      "invalid_input",
      `Invalid Vultr input: ${fields.join(", ")}.`,
    );
  }
  return result.data;
}

export function validateResponse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new AppError(
      "invalid_response",
      "Vultr returned an invalid response.",
    );
  }
  return result.data;
}

export function createBody(
  input: CreateInstanceInput,
): Record<string, unknown> {
  const value = validateInput(create_schema, input);
  return definedFields({
    region: value.region_id,
    plan: value.plan_id,
    os_id: Number(value.image_id),
    label: value.label,
    hostname: value.hostname,
    sshkey_id: value.ssh_key_ids,
    tags: value.tags,
    enable_ipv6: value.enable_ipv6,
  });
}

export function editBody(input: EditInstanceInput): Record<string, unknown> {
  const value = validateInput(edit_schema, input);
  return definedFields({
    label: value.label,
    tags: value.tags,
    plan: value.plan_id,
  });
}

function definedFields(
  input: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  );
}

function instanceStatus(
  value: z.infer<typeof instance_schema>,
): InstanceStatus {
  const status = value.status.toLowerCase();
  const server_status = value.server_status.toLowerCase();
  const power_status = value.power_status.toLowerCase();

  if (status === "pending") return "pending";
  if (status !== "active") return "unknown";
  if (
    [
      "none",
      "locked",
      "installing",
      "installingbooting",
      "isomounting",
      "reinstalling",
      "resizing",
      "rebuilding",
      "migrating",
    ].includes(server_status)
  ) {
    return "pending";
  }
  if (server_status !== "ok") return "unknown";
  if (power_status === "running") return "running";
  if (power_status === "stopped") return "stopped";
  if (["starting", "stopping"].includes(power_status)) return "pending";
  return "unknown";
}

export function normalizeInstance(
  value: z.infer<typeof instance_schema>,
): Instance {
  return {
    provider_id: "vultr",
    id: value.id,
    label: value.label,
    region_id: value.region,
    plan_id: value.plan,
    image_id: String(value.os_id),
    status: instanceStatus(value),
    provider_status: value.status,
    power_status: value.power_status,
    server_status: value.server_status,
    public_ipv4: value.main_ip,
    public_ipv6: value.v6_main_ip,
    tags: value.tags,
  };
}

export function normalizeRegion(value: z.infer<typeof region_schema>): Region {
  return { id: value.id, name: value.city, country: value.country };
}

export function normalizePlan(value: z.infer<typeof plan_schema>): Plan {
  return {
    id: value.id,
    vcpu_count: value.vcpu_count,
    memory_mb: value.ram,
    disk_gb: value.disk,
    monthly_cost: value.monthly_cost,
    currency: "USD",
    region_ids: value.locations,
  };
}

export function normalizeImage(value: z.infer<typeof image_schema>): Image {
  return {
    id: String(value.id),
    name: value.name,
    architecture: value.arch,
    family: value.family,
  };
}

export function normalizeSshKey(value: z.infer<typeof ssh_key_schema>): SshKey {
  return { id: value.id, name: value.name };
}
