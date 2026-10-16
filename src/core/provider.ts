export type InstanceStatus = "pending" | "running" | "stopped" | "unknown";
export type InstanceAction =
  | "create"
  | "edit"
  | "start"
  | "stop"
  | "reboot"
  | "destroy";

export interface Instance {
  provider_id: string;
  id: string;
  label: string;
  region_id: string;
  plan_id: string;
  image_id: string;
  status: InstanceStatus;
  provider_status: string;
  power_status: string;
  server_status: string;
  public_ipv4: string;
  public_ipv6: string;
  tags: string[];
  gpu_name?: string;
  gpu_count?: number;
  gpu_memory_gb?: number;
  monthly_cost?: number;
  hourly_cost?: number;
  currency?: string;
  ssh_host?: string;
  ssh_port?: number;
}

export interface AcceptedInstance {
  provider_id: string;
  id: string;
  status: "accepted";
  label?: string;
}

export type InstanceMutationResult = Instance | AcceptedInstance;

export interface Region {
  id: string;
  name: string;
  country: string;
}

export interface Plan {
  id: string;
  name?: string;
  vcpu_count?: number;
  memory_mb?: number;
  disk_gb?: number;
  monthly_cost?: number;
  hourly_cost?: number;
  gpu_name?: string;
  gpu_count?: number;
  gpu_memory_gb?: number;
  currency: string;
  region_ids: string[];
}

export interface Image {
  id: string;
  name: string;
  architecture: string;
  family: string;
}

export interface SshKey {
  id: string;
  name: string;
}

export interface AccountMetadata {
  provider_id: string;
  email: string;
  currency: string;
  name?: string;
  balance?: number;
  pending_charges?: number;
  last_payment_date?: string;
  last_payment_amount?: number;
  hourly_cost?: number;
  acls?: string[];
}

export interface ProviderRequestOptions {
  signal?: AbortSignal;
}

export interface InstanceListOptions extends ProviderRequestOptions {
  include_pricing?: boolean;
}

export interface CreateInstanceInput {
  region_id?: string;
  plan_id?: string;
  image_id?: string;
  offer_id?: string;
  gpu_count?: number;
  disk_gb?: number;
  volume_gb?: number;
  ports?: string[];
  enable_ssh?: boolean;
  label?: string;
  hostname?: string;
  ssh_key_ids?: string[];
  tags?: string[];
  enable_ipv6?: boolean;
}

export interface EditInstanceInput {
  label?: string;
  tags?: string[];
  plan_id?: string;
}

export interface ProviderInfo {
  id: string;
  name: string;
  capabilities: readonly string[];
  operation_notes?: Partial<Record<InstanceAction, string>>;
}

export interface OfferQuery {
  offer_id?: string;
  gpu_name?: string;
  gpu_count?: number;
  disk_gb?: number;
  limit?: number;
}

export interface Offer {
  id: string;
  gpu_name: string;
  gpu_count: number;
  hourly_cost: number;
  currency: string;
  region_id?: string;
  vcpu_count?: number;
  memory_mb?: number;
  disk_gb?: number;
  gpu_memory_gb?: number;
  reliability?: number;
}

export type MachineType = "shared_cpu" | "dedicated_cpu" | "bare_metal" | "gpu";

export interface MachineQuery {
  id?: string;
  type?: MachineType;
  region_id?: string;
  gpu_name?: string;
  gpu_count?: number;
  disk_gb?: number;
  limit?: number;
  available_only?: boolean;
}

export interface MachineOffer {
  provider_id: string;
  id: string;
  name?: string;
  type: MachineType;
  source: "plan" | "offer";
  availability: "available" | "unavailable" | "unknown";
  region_ids: string[];
  vcpu_count?: number;
  cpu_count?: number;
  cpu_threads?: number;
  cpu_model?: string;
  memory_mb?: number;
  disk_gb?: number;
  disk_count?: number;
  disk_size_gb?: number;
  gpu_name?: string;
  gpu_count?: number;
  gpu_memory_gb?: number;
  monthly_cost?: number;
  hourly_cost?: number;
  currency: string;
}

export interface Provider {
  readonly info: ProviderInfo;
  getAccountMetadata?(
    options?: ProviderRequestOptions,
  ): Promise<AccountMetadata>;
  listInstances(options?: InstanceListOptions): Promise<Instance[]>;
  getInstance(id: string): Promise<Instance>;
  createInstance(input: CreateInstanceInput): Promise<InstanceMutationResult>;
  editInstance(
    id: string,
    input: EditInstanceInput,
  ): Promise<InstanceMutationResult>;
  destroyInstance(id: string): Promise<void>;
  startInstance(id: string): Promise<void>;
  stopInstance(id: string): Promise<void>;
  rebootInstance(id: string): Promise<void>;
  listRegions(): Promise<Region[]>;
  listPlans(region_id?: string): Promise<Plan[]>;
  listOffers?(query?: OfferQuery): Promise<Offer[]>;
  listMachines?(query?: MachineQuery): Promise<MachineOffer[]>;
  listImages(): Promise<Image[]>;
  listSshKeys(): Promise<SshKey[]>;
}

export interface ProviderDefinition {
  info: ProviderInfo;
  credential_fields: readonly string[];
  create_guidance?: CreateGuidance;
  validateInstanceId?(id: string): void;
  validateCreateInput?(input: CreateInstanceInput): void;
  validateCreateDraft?(input: CreateInstanceInput): void;
  validateEditInput?(input: EditInstanceInput): void;
  create(credentials: Readonly<Record<string, string>>): Provider;
}

export interface CreateGuidance {
  machine_types: readonly MachineType[];
  machine_source: "plan" | "offer";
  region: "required" | "optional" | "none";
  image: "catalog" | "docker";
  gpu_count?: boolean;
  disk_gb?: boolean;
  volume_gb?: boolean;
  cost_notice: string;
}
