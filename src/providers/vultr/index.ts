import { z } from "zod";
import { AppError } from "../../core/errors.ts";
import type {
  AccountMetadata,
  CreateInstanceInput,
  EditInstanceInput,
  Image,
  Instance,
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

  async listInstances(options?: ProviderRequestOptions): Promise<Instance[]> {
    return (
      await this.#list(
        "/instances",
        "instances",
        instance_schema,
        options?.signal,
      )
    ).map(normalizeInstance);
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
