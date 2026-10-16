import { isIP } from "node:net";
import { z } from "zod";
import { AppError } from "../../core/errors.ts";
import type {
  AcceptedInstance,
  CreateInstanceInput,
  EditInstanceInput,
  Instance,
  InstanceStatus,
  Offer,
  OfferQuery,
} from "../../core/provider.ts";

const identifier_schema = z
  .string()
  .regex(/^[1-9]\d*$/)
  .refine((value) => Number.isSafeInteger(Number(value)));
const numeric_id = z.number().int().positive().safe();
const text = z
  .string()
  .max(4096)
  .regex(/^[^\p{C}]*$/u);
const label = text.max(1024);
const positive = z.number().finite().positive();
const nonnegative = z.number().finite().nonnegative();
const nullable_text = text.nullish();
const nullable_number = nonnegative.nullish();

const create_schema = z
  .object({
    offer_id: identifier_schema,
    image_id: text.min(1).refine((value) => value.trim() === value),
    disk_gb: positive,
    label: label.optional(),
    enable_ssh: z.literal(true).optional(),
  })
  .strict();
const edit_schema = z.object({ label }).strict();
const query_schema = z
  .object({
    offer_id: identifier_schema.optional(),
    gpu_name: text
      .min(1)
      .max(200)
      .refine((value) => value.trim() === value)
      .optional(),
    gpu_count: z.number().int().positive().optional(),
    disk_gb: positive.optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

export const account_schema = z.object({
  email: z
    .string()
    .trim()
    .min(1)
    .max(254)
    .regex(/^[^\s@]+@[^\s@]+$/),
  balance: z.number().finite().optional(),
});
export const instance_schema = z.object({
  id: numeric_id,
  label: nullable_text,
  actual_status: nullable_text,
  intended_status: nullable_text,
  cur_state: nullable_text,
  image_uuid: nullable_text,
  public_ipaddr: nullable_text,
  dph_total: nullable_number,
  gpu_name: nullable_text,
  num_gpus: z.number().int().nonnegative().nullish(),
  gpu_ram: nullable_number,
  ssh_host: nullable_text,
  ssh_port: z.number().int().min(1).max(65535).nullish(),
});
export const offer_schema = z.object({
  id: numeric_id,
  gpu_name: text.min(1),
  num_gpus: z.number().int().positive(),
  dph_total: nonnegative,
  cpu_cores_effective: nullable_number,
  cpu_ram: nullable_number,
  disk_space: nullable_number,
  gpu_ram: nullable_number,
  reliability: z.number().min(0).max(1).nullish(),
  reliability2: z.number().min(0).max(1).nullish(),
});
export const page_schema = z.object({
  success: z.literal(true).optional(),
  instances: z.array(instance_schema),
  next_token: z.string().min(1).max(16384).nullable(),
});
export const mutation_schema = z.object({ success: z.literal(true) });
export const create_response_schema = mutation_schema.extend({
  new_contract: numeric_id,
});

function validateInput<T>(
  schema: z.ZodType<T>,
  input: unknown,
  message = "Invalid Vast.ai input.",
): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new AppError("invalid_input", message);
  }
  return parsed.data;
}

export function validateResponse<T>(
  schema: z.ZodType<T>,
  response: unknown,
  mutating = false,
): T {
  if (
    response !== null &&
    typeof response === "object" &&
    "success" in response &&
    response.success === false
  ) {
    const code =
      "error" in response && response.error === "auth_error"
        ? "authentication"
        : "provider_error";
    throw new AppError(code, "Vast.ai rejected the operation.");
  }
  const parsed = schema.safeParse(response);
  if (!parsed.success) {
    const advice = mutating
      ? " The request may have succeeded; check your instance inventory before retrying."
      : "";
    throw new AppError(
      "invalid_response",
      `Vast.ai returned an unexpected response.${advice}`,
    );
  }
  return parsed.data;
}

function rejectUnsupported(input: object, fields: readonly string[]): void {
  const values = input as Record<string, unknown>;
  const unsupported_fields = fields.filter(
    (field) => field in values && values[field] !== undefined,
  );
  if (unsupported_fields.length > 0) {
    throw new AppError(
      "unsupported_operation",
      `Vast.ai does not support these options: ${unsupported_fields.join(", ")}.`,
    );
  }
}

function validateCreateOptions(input: CreateInstanceInput): void {
  if (!input || typeof input !== "object") {
    throw new AppError("invalid_input", "Invalid Vast.ai create input.");
  }
  rejectUnsupported(input, [
    "region_id",
    "plan_id",
    "hostname",
    "ssh_key_ids",
    "tags",
    "enable_ipv6",
    "gpu_count",
    "volume_gb",
    "ports",
  ]);
  if (input.enable_ssh !== undefined && input.enable_ssh !== true) {
    throw new AppError(
      "unsupported_operation",
      "Vast.ai creation uses the SSH launch mode.",
    );
  }
}

export function validateCreateInput(input: CreateInstanceInput): void {
  validateCreateOptions(input);
  validateInput(
    create_schema,
    input,
    "Vast.ai creation requires a positive decimal --offer ID, a Docker --image, and a positive --disk-gb size. Optional fields are --label and --ssh.",
  );
}

export function validateCreateDraft(input: CreateInstanceInput): void {
  validateCreateOptions(input);
  validateInput(create_schema.partial(), input);
}

export function createBody(
  input: CreateInstanceInput,
): Record<string, unknown> {
  validateCreateInput(input);
  const value = validateInput(create_schema, input);
  return {
    client_id: "me",
    image: value.image_id,
    disk: value.disk_gb,
    runtype: "ssh",
    cancel_unavail: true,
    ...(value.label === undefined ? {} : { label: value.label }),
  };
}

export function validateEditInput(input: EditInstanceInput): void {
  if (!input || typeof input !== "object") {
    throw new AppError("invalid_input", "Invalid Vast.ai edit input.");
  }
  rejectUnsupported(input, ["tags", "plan_id"]);
  validateInput(
    edit_schema,
    input,
    "Vast.ai editing requires --label with at most 1024 characters.",
  );
}

export function editBody(input: EditInstanceInput): { label: string } {
  validateEditInput(input);
  return validateInput(edit_schema, input);
}

export function instancePath(id: string): string {
  return `/v0/instances/${validateInput(identifier_schema, id)}/`;
}

export function offerPath(id: string | undefined): string {
  return `/v0/asks/${validateInput(identifier_schema, id)}/`;
}

export function offerBody(query: OfferQuery = {}): Record<string, unknown> {
  const value = validateInput(query_schema, query);
  return {
    type: "ondemand",
    verified: { eq: true },
    rentable: { eq: true },
    rented: { eq: false },
    external: { eq: false },
    order: [["dph_total", "asc"]],
    limit: value.limit ?? 20,
    ...(value.offer_id === undefined
      ? {}
      : { id: { eq: Number(value.offer_id) } }),
    ...(value.gpu_name === undefined
      ? {}
      : { gpu_name: { eq: value.gpu_name } }),
    ...(value.gpu_count === undefined
      ? {}
      : { num_gpus: { eq: value.gpu_count } }),
    ...(value.disk_gb === undefined
      ? {}
      : {
          allocated_storage: value.disk_gb,
          disk_space: { gte: value.disk_gb },
        }),
  };
}

function status(value: string | null | undefined): InstanceStatus {
  if (value === "running") return "running";
  if (value === "stopped" || value === "exited") return "stopped";
  if (
    [
      "created",
      "creating",
      "loading",
      "scheduling",
      "connecting",
      "rebooting",
    ].includes(value ?? "")
  ) {
    return "pending";
  }
  return "unknown";
}

export function normalizeInstance(
  value: z.infer<typeof instance_schema>,
): Instance {
  return {
    provider_id: "vast",
    id: String(value.id),
    label: value.label ?? "",
    region_id: "",
    plan_id: "",
    image_id: value.image_uuid ?? "",
    status: status(value.actual_status),
    provider_status: value.actual_status ?? "",
    power_status: value.intended_status ?? "",
    server_status: value.cur_state ?? "",
    public_ipv4:
      isIP(value.public_ipaddr ?? "") === 4 ? (value.public_ipaddr ?? "") : "",
    public_ipv6:
      isIP(value.public_ipaddr ?? "") === 6 ? (value.public_ipaddr ?? "") : "",
    tags: [],
    ...(value.dph_total == null ? {} : { hourly_cost: value.dph_total }),
    ...(value.gpu_name == null ? {} : { gpu_name: value.gpu_name }),
    ...(value.num_gpus == null ? {} : { gpu_count: value.num_gpus }),
    ...(value.gpu_ram == null ? {} : { gpu_memory_gb: value.gpu_ram / 1000 }),
    ...(value.ssh_host == null ? {} : { ssh_host: value.ssh_host }),
    ...(value.ssh_port == null ? {} : { ssh_port: value.ssh_port }),
  };
}

export function acceptedInstance(
  id: number,
  input: Pick<CreateInstanceInput, "label">,
): AcceptedInstance {
  return {
    provider_id: "vast",
    id: String(id),
    status: "accepted",
    ...(input.label === undefined ? {} : { label: input.label }),
  };
}

export function normalizeOffer(value: z.infer<typeof offer_schema>): Offer {
  const reliability = value.reliability ?? value.reliability2;
  return {
    id: String(value.id),
    gpu_name: value.gpu_name,
    gpu_count: value.num_gpus,
    hourly_cost: value.dph_total,
    currency: "USD",
    ...(value.cpu_cores_effective == null
      ? {}
      : { vcpu_count: value.cpu_cores_effective }),
    ...(value.cpu_ram == null ? {} : { memory_mb: value.cpu_ram }),
    ...(value.disk_space == null ? {} : { disk_gb: value.disk_space }),
    ...(value.gpu_ram == null ? {} : { gpu_memory_gb: value.gpu_ram / 1000 }),
    ...(reliability == null ? {} : { reliability }),
  };
}
