import { isIP } from "node:net";
import { z } from "zod";
import { AppError } from "../../core/errors.ts";
import type {
  CreateInstanceInput,
  EditInstanceInput,
  Instance,
  InstanceStatus,
  MachineOffer,
} from "../../core/provider.ts";

const text_schema = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => !/\p{C}/u.test(value));
export const identifier_schema = z.string().regex(/^[A-Za-z0-9_-]+$/);
const docker_image_schema = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/);
const port_schema = z
  .string()
  .regex(/^[1-9][0-9]{0,4}\/(tcp|http)$/)
  .refine((value) => Number(value.split("/")[0]) <= 65535);

const create_schema = z.strictObject({
  region_id: identifier_schema.optional(),
  plan_id: text_schema,
  image_id: docker_image_schema,
  label: text_schema.refine((value) => value.trim().length > 0),
  gpu_count: z.number().int().positive().safe().optional(),
  disk_gb: z.number().int().positive().safe(),
  volume_gb: z
    .number()
    .int()
    .nonnegative()
    .safe()
    .refine(
      (value) => value === 0 || value >= 10,
      "Persistent storage must be zero or at least 10 GB.",
    )
    .optional(),
  ports: z.array(port_schema).optional(),
  enable_ssh: z.boolean().optional(),
});

const edit_schema = z.strictObject({
  label: text_schema.refine((value) => value.trim().length > 0),
});

const create_fields = new Set(Object.keys(create_schema.shape));
const edit_fields = new Set(Object.keys(edit_schema.shape));

function rejectUnsupported(input: unknown, fields: Set<string>): void {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return;
  if (Object.keys(input).some((field) => !fields.has(field))) {
    throw new AppError(
      "unsupported_operation",
      "RunPod does not support one or more supplied options for this operation.",
    );
  }
}

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const fields = [
      ...new Set(
        result.error.issues.map((issue) => issue.path.join(".") || "input"),
      ),
    ];
    throw new AppError(
      "invalid_input",
      `Invalid RunPod input: ${fields.join(", ")}.`,
    );
  }
  return result.data;
}

export function validateCreateInput(input: CreateInstanceInput): void {
  rejectUnsupported(input, create_fields);
  parseInput(create_schema, input);
}

export function validateCreateDraft(input: CreateInstanceInput): void {
  rejectUnsupported(input, create_fields);
  parseInput(create_schema.partial(), input);
}

export function validateEditInput(input: EditInstanceInput): void {
  rejectUnsupported(input, edit_fields);
  parseInput(edit_schema, input);
}

export function createBody(
  input: CreateInstanceInput,
): Record<string, unknown> {
  validateCreateInput(input);
  const value = parseInput(create_schema, input);
  const ports = [...new Set(value.ports ?? [])];
  if (value.enable_ssh && !ports.includes("22/tcp")) ports.push("22/tcp");
  return {
    name: value.label,
    image: value.image_id,
    cloud: "SECURE",
    gpu: { id: value.plan_id, count: value.gpu_count ?? 1 },
    disk: value.disk_gb,
    ...(value.region_id === undefined
      ? {}
      : { dataCenterIds: [value.region_id] }),
    ...(ports.length === 0 ? {} : { ports }),
    ...(value.enable_ssh === undefined ? {} : { startSsh: value.enable_ssh }),
    ...((value.volume_gb ?? 0) === 0
      ? {}
      : {
          mounts: { persistent: { size: value.volume_gb, path: "/workspace" } },
        }),
  };
}

export function editBody(input: EditInstanceInput): Record<string, unknown> {
  validateEditInput(input);
  return { name: parseInput(edit_schema, input).label };
}

export function validateResponse<T>(
  schema: z.ZodType<T>,
  input: unknown,
  mutating = false,
): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new AppError(
      "invalid_response",
      `RunPod returned an invalid response.${mutating ? " The request may have succeeded; verify the Pod state before retrying." : ""}`,
    );
  }
  return result.data;
}

const ssh_endpoint_schema = z.object({
  host: z.string().min(1),
  port: z.number().int().positive().max(65535),
  username: z.string().min(1).nullish(),
});

export const pod_schema = z.object({
  id: z.string().min(1),
  name: z.string(),
  image: z.string(),
  status: z.string(),
  dataCenterId: z.string().nullable().optional(),
  gpu: z
    .object({
      id: z.string(),
      count: z.number().int().positive().optional(),
    })
    .nullable()
    .optional(),
  cpu: z.object({ id: z.string() }).nullable().optional(),
  cost: z.number().nonnegative().optional(),
  ssh: z
    .object({
      proxy: ssh_endpoint_schema.nullable().optional(),
      direct: ssh_endpoint_schema.nullable().optional(),
    })
    .nullable()
    .optional(),
});

export const accepted_pod_schema = z.object({
  id: identifier_schema,
});

export const pods_page_schema = z.object({
  pods: z.array(pod_schema),
  pagination: z.object({
    nextCursor: z.string().min(1).nullable(),
    hasNextPage: z.boolean(),
  }),
});

export const account_response_schema = z.object({
  data: z.object({
    myself: z.object({
      email: z.string().min(1),
      clientBalance: z.number().nullable().optional(),
      currentSpendPerHr: z.number().nonnegative().nullable().optional(),
      information: z
        .object({
          firstName: z.string().nullable().optional(),
          lastName: z.string().nullable().optional(),
        })
        .nullable()
        .optional(),
    }),
  }),
});

export const graphql_errors_schema = z.object({
  errors: z
    .array(
      z.object({
        extensions: z.object({ code: z.string().optional() }).optional(),
      }),
    )
    .optional(),
});

export const regions_schema = z.object({
  dataCenters: z.array(z.object({ id: z.string().min(1), name: z.string() })),
});

const gpu_plan_schema = z.object({
  id: z.string().min(1),
  name: z.string(),
  memory: z.number().nonnegative(),
  secure: z.boolean(),
  price: z.object({ secure: z.number().nonnegative() }),
  dataCenters: z
    .array(
      z.object({
        id: z.string().min(1),
        availability: z.string(),
      }),
    )
    .optional(),
});

export const plans_schema = z.object({ gpus: z.array(gpu_plan_schema) });

const gpu_machine_schema = gpu_plan_schema.extend({
  availability: z.string().optional(),
  maxCount: z.object({ secure: z.number().int().nonnegative() }).optional(),
});

export const machines_schema = z.object({
  gpus: z.array(gpu_machine_schema),
});

function machineAvailability(value?: string): MachineOffer["availability"] {
  switch (value) {
    case "LOW":
    case "MEDIUM":
    case "HIGH":
      return "available";
    case "NONE":
      return "unavailable";
    default:
      return "unknown";
  }
}

export function normalizeMachine(
  gpu: z.infer<typeof gpu_machine_schema>,
  gpu_count: number,
  region_id?: string,
): MachineOffer {
  const regions = gpu.dataCenters ?? [];
  const availability = machineAvailability(
    region_id === undefined
      ? gpu.availability
      : regions.find((region) => region.id === region_id)?.availability,
  );
  const hourly_cost = gpu.price.secure * gpu_count;
  return {
    provider_id: "runpod",
    id: gpu.id,
    name: gpu.name,
    type: "gpu",
    source: "plan",
    availability:
      gpu.maxCount !== undefined && gpu_count > gpu.maxCount.secure
        ? "unavailable"
        : availability,
    region_ids: [
      ...new Set(
        regions
          .filter(
            (region) => region_id === undefined || region.id === region_id,
          )
          .map((region) => region.id),
      ),
    ],
    gpu_name: gpu.name,
    gpu_count,
    gpu_memory_gb: gpu.memory,
    ...(Number.isFinite(hourly_cost) ? { hourly_cost } : {}),
    currency: "USD",
  };
}

export function parseIdentifier(id: string): string {
  return parseInput(identifier_schema, id);
}

function status(value: string): InstanceStatus {
  switch (value) {
    case "RUNNING":
      return "running";
    case "EXITED":
      return "stopped";
    case "PROVISIONING":
    case "STARTING":
      return "pending";
    default:
      return "unknown";
  }
}

export function normalizeInstance(value: z.infer<typeof pod_schema>): Instance {
  const state = status(value.status);
  const ssh_endpoint = value.ssh?.direct ?? value.ssh?.proxy;
  const direct_host = value.ssh?.direct?.host ?? "";
  return {
    provider_id: "runpod",
    id: value.id,
    label: value.name,
    region_id: value.dataCenterId ?? "",
    plan_id: value.gpu?.id ?? value.cpu?.id ?? "",
    image_id: value.image,
    status: state,
    provider_status: value.status,
    power_status: state === "running" || state === "stopped" ? state : "",
    server_status: "",
    public_ipv4: isIP(direct_host) === 4 ? direct_host : "",
    public_ipv6: isIP(direct_host) === 6 ? direct_host : "",
    tags: [],
    ...(value.gpu === undefined || value.gpu === null
      ? {}
      : { gpu_name: value.gpu.id }),
    ...(value.gpu?.count === undefined ? {} : { gpu_count: value.gpu.count }),
    ...(value.cost === undefined ? {} : { hourly_cost: value.cost }),
    ...(ssh_endpoint === undefined || ssh_endpoint === null
      ? {}
      : {
          ssh_host: ssh_endpoint.host,
          ssh_port: ssh_endpoint.port,
          ssh_method: value.ssh?.direct == null ? "proxy" : "direct",
          ...(ssh_endpoint.username == null
            ? {}
            : { ssh_user: ssh_endpoint.username }),
        }),
  };
}
