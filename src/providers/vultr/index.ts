import { z } from "zod";
import { AppError } from "../../core/errors.ts";
import type {
  AccountMetadata,
  CreateInstanceInput,
  EditInstanceInput,
  Image,
  Instance,
  InstanceListOptions,
  Plan,
  Provider,
  ProviderInfo,
  ProviderRequestOptions,
  Region,
  SshKey,
} from "../../core/provider.ts";
import {
  account_schema,
  createBody,
  editBody,
  identifier_schema,
  image_schema,
  instance_schema,
  normalizeAccountMetadata,
  normalizeImage,
  normalizeInstance,
  normalizePlan,
  normalizeRegion,
  normalizeSshKey,
  pagination_schema,
  plan_price_schema,
  plan_schema,
  region_schema,
  ssh_key_schema,
  validateInput,
  validateResponse,
} from "./schemas.ts";
import { type VultrOptions, VultrTransport } from "./transport.ts";

export const vultr_info: ProviderInfo = {
  id: "vultr",
  name: "Vultr",
  capabilities: [
    "list",
    "get",
    "create",
    "edit",
    "resize",
    "destroy",
    "start",
    "stop",
    "reboot",
    "regions",
    "plans",
    "images",
    "ssh_keys",
    "account_metadata",
  ],
  operation_notes: {
    start: "Vultr may restart an already running instance.",
    stop: "Vultr billing continues until the instance is destroyed.",
    destroy: "Vultr releases the instance's IP address when it is destroyed.",
  },
};

export class VultrProvider implements Provider {
  readonly info = vultr_info;
  #transport: VultrTransport;

  constructor(options: VultrOptions) {
    this.#transport = new VultrTransport(options);
  }

  async getAccountMetadata(
    options?: ProviderRequestOptions,
  ): Promise<AccountMetadata> {
    const response = await this.#transport.request(
      "/account",
      "GET",
      undefined,
      true,
      options?.signal,
    );
    const result = validateResponse(
      z.object({ account: account_schema }),
      response,
    );
    return normalizeAccountMetadata(result.account);
  }

  async listInstances(options?: InstanceListOptions): Promise<Instance[]> {
    const instances = (
      await this.#list(
        "/instances",
        "instances",
        instance_schema,
        options?.signal,
      )
    ).map(normalizeInstance);
    if (!options?.include_pricing || instances.length === 0) return instances;

    try {
      const plans = await this.#list(
        "/plans",
        "plans",
        plan_price_schema,
        options.signal,
      );
      const prices = new Map<string, number | undefined>();
      const ambiguous_ids = new Set<string>();
      for (const plan of plans) {
        if (ambiguous_ids.has(plan.id)) continue;
        const monthly_cost = plan.monthly_cost ?? undefined;
        if (prices.has(plan.id) && prices.get(plan.id) !== monthly_cost) {
          prices.delete(plan.id);
          ambiguous_ids.add(plan.id);
        } else {
          prices.set(plan.id, monthly_cost);
        }
      }
      return instances.map((instance) => {
        const monthly_cost = prices.get(instance.plan_id);
        return monthly_cost === undefined
          ? instance
          : { ...instance, monthly_cost, currency: "USD" };
      });
    } catch (error) {
      if (options.signal?.aborted) {
        throw new AppError("cancelled", "Operation cancelled.");
      }
      if (error instanceof AppError && error.code === "cancelled") throw error;
      return instances;
    }
  }

  async getInstance(id: string): Promise<Instance> {
    const response = await this.#transport.request(instancePath(id));
    return instanceResponse(response);
  }

  async createInstance(input: CreateInstanceInput): Promise<Instance> {
    const response = await this.#transport.request(
      "/instances",
      "POST",
      createBody(input),
    );
    return instanceResponse(response, true);
  }

  async editInstance(id: string, input: EditInstanceInput): Promise<Instance> {
    const path = instancePath(id);
    const body = editBody(input);
    const response = await this.#transport.request(path, "PATCH", body);
    return instanceResponse(response, true);
  }

  async destroyInstance(id: string): Promise<void> {
    await this.#transport.request(instancePath(id), "DELETE", undefined, false);
  }

  async startInstance(id: string): Promise<void> {
    await this.#action(id, "start");
  }

  async stopInstance(id: string): Promise<void> {
    await this.#action(id, "halt");
  }

  async rebootInstance(id: string): Promise<void> {
    await this.#action(id, "reboot");
  }

  async listRegions(): Promise<Region[]> {
    return (await this.#list("/regions", "regions", region_schema)).map(
      normalizeRegion,
    );
  }

  async listPlans(region_id?: string): Promise<Plan[]> {
    if (region_id !== undefined) validateInput(identifier_schema, region_id);
    const plans = (await this.#list("/plans", "plans", plan_schema)).map(
      normalizePlan,
    );
    return region_id === undefined
      ? plans
      : plans.filter((plan) => plan.region_ids.includes(region_id));
  }

  async listImages(): Promise<Image[]> {
    return (await this.#list("/os", "os", image_schema)).map(normalizeImage);
  }

  async listSshKeys(): Promise<SshKey[]> {
    return (await this.#list("/ssh-keys", "ssh_keys", ssh_key_schema)).map(
      normalizeSshKey,
    );
  }

  async #action(
    id: string,
    action: "start" | "halt" | "reboot",
  ): Promise<void> {
    await this.#transport.request(
      `${instancePath(id)}/${action}`,
      "POST",
      undefined,
      false,
    );
  }

  async #list<T>(
    path: string,
    field: string,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T[]> {
    const items: T[] = [];
    const seen_cursors = new Set<string>();
    let cursor: string | undefined;

    while (true) {
      const query = new URLSearchParams({ per_page: "500" });
      if (cursor !== undefined) query.set("cursor", cursor);
      const response = await this.#transport.request(
        `${path}?${query}`,
        "GET",
        undefined,
        true,
        signal,
      );
      const page = validateResponse(
        z.record(z.string(), z.unknown()),
        response,
      );
      items.push(...validateResponse(z.array(schema), page[field]));
      const pagination = validateResponse(pagination_schema, page);
      const next_cursor = pagination.meta?.links?.next;
      if (!next_cursor) return items;
      if (seen_cursors.has(next_cursor)) {
        throw new AppError(
          "invalid_response",
          "Vultr returned a repeated pagination cursor.",
        );
      }
      seen_cursors.add(next_cursor);
      cursor = next_cursor;
    }
  }
}

function instancePath(id: string): string {
  return `/instances/${encodeURIComponent(validateInput(identifier_schema, id))}`;
}

function instanceResponse(response: unknown, mutating = false): Instance {
  try {
    const result = validateResponse(
      z.object({ instance: instance_schema }),
      response,
    );
    return normalizeInstance(result.instance);
  } catch (error) {
    if (
      mutating &&
      error instanceof AppError &&
      error.code === "invalid_response"
    ) {
      throw new AppError(
        "invalid_response",
        "Vultr returned an invalid response. The request may have succeeded; verify the instance state before retrying.",
      );
    }
    throw error;
  }
}
