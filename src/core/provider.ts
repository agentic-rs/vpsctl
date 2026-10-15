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
}

export interface Region {
  id: string;
  name: string;
  country: string;
}

export interface Plan {
  id: string;
  vcpu_count: number;
  memory_mb: number;
  disk_gb: number;
  monthly_cost: number;
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

export interface CreateInstanceInput {
  region_id: string;
  plan_id: string;
  image_id: string;
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

export interface Provider {
  readonly info: ProviderInfo;
  listInstances(): Promise<Instance[]>;
  getInstance(id: string): Promise<Instance>;
  createInstance(input: CreateInstanceInput): Promise<Instance>;
  editInstance(id: string, input: EditInstanceInput): Promise<Instance>;
  destroyInstance(id: string): Promise<void>;
  startInstance(id: string): Promise<void>;
  stopInstance(id: string): Promise<void>;
  rebootInstance(id: string): Promise<void>;
  listRegions(): Promise<Region[]>;
  listPlans(region_id?: string): Promise<Plan[]>;
  listImages(): Promise<Image[]>;
  listSshKeys(): Promise<SshKey[]>;
}

export interface ProviderDefinition {
  info: ProviderInfo;
  credential_fields: readonly string[];
  create(credentials: Readonly<Record<string, string>>): Provider;
}
