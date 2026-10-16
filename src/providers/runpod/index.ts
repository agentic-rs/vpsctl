import { AppError } from "../../core/errors.ts";
import { filterMachines, validateMachineQuery } from "../../core/machines.ts";
import type {
  AccountMetadata,
  CreateInstanceInput,
  EditInstanceInput,
  Image,
  Instance,
  InstanceMutationResult,
  MachineOffer,
  MachineQuery,
  Plan,
  Provider,
  ProviderInfo,
  ProviderRequestOptions,
  Region,
  SshKey,
} from "../../core/provider.ts";
import { type HttpOptions, ProviderHttp } from "../http.ts";
import {
  accepted_pod_schema,
  account_response_schema,
  createBody,
  editBody,
  graphql_errors_schema,
  machines_schema,
  normalizeInstance,
  normalizeMachine,
  parseIdentifier,
  plans_schema,
  pod_schema,
  pods_page_schema,
  regions_schema,
  validateResponse,
} from "./schemas.ts";

export { validateCreateInput, validateEditInput } from "./schemas.ts";

export const runpod_info: ProviderInfo = {
  id: "runpod",
  name: "RunPod",
  capabilities: [
    "list",
    "get",
    "create",
    "edit",
    "destroy",
    "start",
    "stop",
    "reboot",
    "regions",
    "plans",
    "machines",
    "account_metadata",
  ],
  operation_notes: {
    create:
      "Creates an on-demand Secure Cloud GPU Pod. Container disk is temporary; --volume-gb adds host-local storage at /workspace. --ssh uses account-registered keys and adds 22/tcp; the image must support RunPod SSH initialization.",
    edit: "Only the Pod name is editable through this CLI; GPU resizing and tags are unsupported.",
    start:
      "Starting a stopped Pod depends on GPU availability on its assigned host.",
    stop: "Stopping erases the container disk and releases the GPU. Retained volume storage continues to incur charges.",
    reboot:
      "Restarting resets the container disk. Only persistent or network-mounted data is retained.",
    destroy:
      "Terminating permanently deletes the Pod and its host-local data. Separately managed network volumes survive and continue billing.",
  },
};

export class RunpodProvider implements Provider {
  readonly info = runpod_info;
  #http: ProviderHttp;
  #graphql: ProviderHttp;

  constructor(options: HttpOptions) {
    this.#http = new ProviderHttp(
      "RunPod",
      "https://api.runpod.io/v2",
      options,
    );
    this.#graphql = new ProviderHttp(
      "RunPod",
      "https://api.runpod.io",
      options,
    );
  }

  async getAccountMetadata(
    options?: ProviderRequestOptions,
  ): Promise<AccountMetadata> {
    const response = await this.#graphql.request("/graphql", {
      method: "POST",
      body: {
        query:
          "query AccountMetadata { myself { email clientBalance currentSpendPerHr information { firstName lastName } } }",
      },
      mutating: false,
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
    const envelope = validateResponse(graphql_errors_schema, response);
    if (envelope.errors?.length) {
      const codes = envelope.errors.map((error) =>
        error.extensions?.code?.toUpperCase(),
      );
      if (
        codes.some(
          (code) => code === "UNAUTHENTICATED" || code === "UNAUTHORIZED",
        )
      ) {
        throw new AppError(
          "authentication",
          "RunPod rejected the account metadata request. Check the API key.",
        );
      }
      if (codes.includes("FORBIDDEN")) {
        throw new AppError(
          "forbidden",
          "RunPod denied account metadata access. Check the API key's GraphQL read permissions.",
        );
      }
      throw new AppError(
        "provider_error",
        "RunPod could not return account metadata. Check GraphQL read access for this API key.",
      );
    }
    const account = validateResponse(account_response_schema, response).data
      .myself;
    const name = [account.information?.firstName, account.information?.lastName]
      .filter(
        (part): part is string =>
          typeof part === "string" && part.trim().length > 0,
      )
      .join(" ");
    return {
      provider_id: "runpod",
      email: account.email,
      currency: "USD",
      ...(name === "" ? {} : { name }),
      ...(account.clientBalance == null
        ? {}
        : { balance: account.clientBalance }),
      ...(account.currentSpendPerHr == null
        ? {}
        : { hourly_cost: account.currentSpendPerHr }),
    };
  }

  async listInstances(options?: ProviderRequestOptions): Promise<Instance[]> {
    const instances: Instance[] = [];
    const seen_cursors = new Set<string>();
    let cursor: string | undefined;
    while (true) {
      const query = new URLSearchParams({ limit: "1000" });
      if (cursor !== undefined) query.set("cursor", cursor);
      const response = await this.#http.request(`/pods?${query}`, {
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
      const page = validateResponse(pods_page_schema, response);
      instances.push(...page.pods.map(normalizeInstance));
      if (!page.pagination.hasNextPage) return instances;
      const next_cursor = page.pagination.nextCursor;
      if (next_cursor === null || seen_cursors.has(next_cursor)) {
        throw new AppError(
          "invalid_response",
          "RunPod returned invalid pagination metadata.",
        );
      }
      seen_cursors.add(next_cursor);
      cursor = next_cursor;
    }
  }

  async getInstance(id: string): Promise<Instance> {
    return normalizeInstance(
      validateResponse(pod_schema, await this.#http.request(podPath(id))),
    );
  }

  async createInstance(
    input: CreateInstanceInput,
  ): Promise<InstanceMutationResult> {
    const body = createBody(input);
    const response = await this.#http.request("/pods", {
      method: "POST",
      body,
    });
    return mutationResponse(response, input.label);
  }

  async editInstance(
    id: string,
    input: EditInstanceInput,
  ): Promise<InstanceMutationResult> {
    const path = podPath(id);
    const body = editBody(input);
    const response = await this.#http.request(path, { method: "PATCH", body });
    return mutationResponse(response, input.label, id);
  }

  async destroyInstance(id: string): Promise<void> {
    await this.#http.request(podPath(id), {
      method: "DELETE",
      expects_json: false,
    });
  }

  async startInstance(id: string): Promise<void> {
    await this.#action(id, "start");
  }

  async stopInstance(id: string): Promise<void> {
    await this.#action(id, "stop");
  }

  async rebootInstance(id: string): Promise<void> {
    await this.#action(id, "restart");
  }

  async listRegions(): Promise<Region[]> {
    const response = await this.#http.request("/catalog/datacenters");
    return validateResponse(regions_schema, response).dataCenters.map(
      (region) => ({
        id: region.id,
        name: region.name,
        country: "",
      }),
    );
  }

  async listPlans(region_id?: string): Promise<Plan[]> {
    if (region_id !== undefined) parseIdentifier(region_id);
    const response = await this.#http.request(
      "/catalog/gpus?include=AVAILABILITY&product=POD&cloud=SECURE&count=1",
    );
    const plans: Plan[] = validateResponse(plans_schema, response)
      .gpus.filter((gpu) => gpu.secure)
      .map((gpu) => ({
        id: gpu.id,
        name: gpu.name,
        gpu_name: gpu.name,
        gpu_count: 1,
        gpu_memory_gb: gpu.memory,
        hourly_cost: gpu.price.secure,
        currency: "USD",
        region_ids: (gpu.dataCenters ?? [])
          .filter((region) =>
            ["LOW", "MEDIUM", "HIGH"].includes(region.availability),
          )
          .map((region) => region.id),
      }));
    return region_id === undefined
      ? plans
      : plans.filter((plan) => plan.region_ids.includes(region_id));
  }

  async listMachines(query?: MachineQuery): Promise<MachineOffer[]> {
    const filters = validateMachineQuery(query);
    if (filters.type !== undefined && filters.type !== "gpu") return [];
    const gpu_count = filters.gpu_count ?? 1;
    const parameters = new URLSearchParams({
      include: "AVAILABILITY",
      product: "POD",
      cloud: "SECURE",
      count: String(gpu_count),
    });
    const response = await this.#http.request(`/catalog/gpus?${parameters}`);
    const machines = validateResponse(machines_schema, response)
      .gpus.filter((gpu) => gpu.secure)
      .map((gpu) => normalizeMachine(gpu, gpu_count, filters.region_id));
    return filterMachines(machines, filters);
  }

  async listImages(): Promise<Image[]> {
    throw new AppError(
      "unsupported_operation",
      "RunPod accepts a Docker image reference via --image. Pod templates are a separate catalog and are not image IDs.",
    );
  }

  async listSshKeys(): Promise<SshKey[]> {
    throw new AppError(
      "unsupported_operation",
      "RunPod uses account-registered SSH public keys rather than selectable key IDs. Register keys in RunPod and create the Pod with --ssh.",
    );
  }

  async #action(
    id: string,
    action: "start" | "stop" | "restart",
  ): Promise<void> {
    await this.#http.request(`${podPath(id)}/action`, {
      method: "POST",
      body: { action },
      expects_json: false,
    });
  }
}

function podPath(id: string): string {
  return `/pods/${encodeURIComponent(parseIdentifier(id))}`;
}

function mutationResponse(
  response: unknown,
  label?: string,
  expected_id?: string,
): InstanceMutationResult {
  const accepted = validateResponse(accepted_pod_schema, response, true);
  if (expected_id !== undefined && accepted.id !== expected_id) {
    throw new AppError(
      "invalid_response",
      "RunPod returned a different Pod ID. The request may have succeeded; verify the Pod state before retrying.",
    );
  }
  const pod = pod_schema.safeParse(response);
  if (pod.success) return normalizeInstance(pod.data);
  return {
    provider_id: "runpod",
    id: accepted.id,
    status: "accepted",
    ...(label === undefined ? {} : { label }),
  };
}
