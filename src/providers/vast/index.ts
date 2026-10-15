import { z } from "zod";
import { AppError } from "../../core/errors.ts";
import type {
  AccountMetadata,
  CreateInstanceInput,
  EditInstanceInput,
  Image,
  Instance,
  InstanceMutationResult,
  Offer,
  OfferQuery,
  Plan,
  Provider,
  ProviderInfo,
  ProviderRequestOptions,
  Region,
  SshKey,
} from "../../core/provider.ts";
import { type HttpOptions, ProviderHttp } from "../http.ts";
import {
  acceptedInstance,
  account_schema,
  create_response_schema,
  createBody,
  editBody,
  instance_schema,
  instancePath,
  mutation_schema,
  normalizeInstance,
  normalizeOffer,
  offer_schema,
  offerBody,
  offerPath,
  page_schema,
  validateResponse,
} from "./schemas.ts";

export { validateCreateInput, validateEditInput } from "./schemas.ts";

export const vast_info: ProviderInfo = {
  id: "vast",
  name: "Vast.ai",
  capabilities: [
    "list",
    "get",
    "create",
    "edit",
    "destroy",
    "start",
    "stop",
    "reboot",
    "offers",
    "account_metadata",
  ],
  operation_notes: {
    create:
      "Vast.ai rents an on-demand offer as a Docker container. Compute, storage, and bandwidth are billed separately; offer availability can change.",
    start:
      "A stopped Vast.ai instance must reclaim GPU capacity and may wait for availability.",
    stop: "Vast.ai preserves instance data when stopped and continues charging for storage.",
    destroy:
      "Destroying a Vast.ai instance permanently deletes its container data.",
  },
};

function unsupported(message: string): never {
  throw new AppError("unsupported_operation", message);
}

export class VastProvider implements Provider {
  readonly info = vast_info;
  #http: ProviderHttp;

  constructor(options: HttpOptions) {
    this.#http = new ProviderHttp(
      "Vast.ai",
      "https://cloud.vast.ai/api",
      options,
    );
  }

  async getAccountMetadata(
    options?: ProviderRequestOptions,
  ): Promise<AccountMetadata> {
    const response = await this.#http.request("/v0/users/current/", {
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
    const value = validateResponse(account_schema, response);
    return {
      provider_id: "vast",
      email: value.email,
      currency: "USD",
      ...(value.balance === undefined ? {} : { balance: value.balance }),
    };
  }

  async listInstances(options?: ProviderRequestOptions): Promise<Instance[]> {
    const result: Instance[] = [];
    const seen_tokens = new Set<string>();
    const seen_ids = new Set<string>();
    let next_token: string | undefined;
    while (true) {
      const query = new URLSearchParams({
        limit: "25",
        order_by: JSON.stringify([{ col: "id", dir: "asc" }]),
      });
      if (next_token !== undefined) query.set("after_token", next_token);
      const response = await this.#http.request(`/v1/instances/?${query}`, {
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
      const page = validateResponse(page_schema, response);
      for (const value of page.instances) {
        const instance = normalizeInstance(value);
        if (seen_ids.has(instance.id)) {
          throw new AppError(
            "invalid_response",
            "Vast.ai returned duplicate instances while paginating.",
          );
        }
        seen_ids.add(instance.id);
        result.push(instance);
      }
      if (page.next_token === null) return result;
      if (seen_tokens.has(page.next_token)) {
        throw new AppError(
          "invalid_response",
          "Vast.ai repeated an instance pagination cursor.",
        );
      }
      seen_tokens.add(page.next_token);
      next_token = page.next_token;
    }
  }

  async getInstance(id: string): Promise<Instance> {
    const response = await this.#http.request(`${instancePath(id)}?owner=me`);
    const envelope = validateResponse(
      z.object({ instances: instance_schema.nullable() }),
      response,
    );
    if (envelope.instances === null) {
      throw new AppError("not_found", "Vast.ai instance was not found.");
    }
    return normalizeInstance(envelope.instances);
  }

  async createInstance(
    input: CreateInstanceInput,
  ): Promise<InstanceMutationResult> {
    const body = createBody(input);
    const response = await this.#http.request(offerPath(input.offer_id), {
      method: "PUT",
      body,
    });
    const value = validateResponse(create_response_schema, response, true);
    return acceptedInstance(value.new_contract, input);
  }

  async editInstance(
    id: string,
    input: EditInstanceInput,
  ): Promise<InstanceMutationResult> {
    const path = instancePath(id);
    const body = editBody(input);
    const response = await this.#http.request(path, { method: "PUT", body });
    validateResponse(mutation_schema, response, true);
    // An acknowledged label update is already successful. A second read could
    // fail and incorrectly tell the caller to repeat the mutation.
    return acceptedInstance(Number(id), { label: body.label });
  }

  async destroyInstance(id: string): Promise<void> {
    const response = await this.#http.request(instancePath(id), {
      method: "DELETE",
    });
    validateResponse(mutation_schema, response, true);
  }

  async startInstance(id: string): Promise<void> {
    await this.#state(id, "running");
  }

  async stopInstance(id: string): Promise<void> {
    await this.#state(id, "stopped");
  }

  async rebootInstance(id: string): Promise<void> {
    instancePath(id);
    const response = await this.#http.request(`/v0/instances/reboot/${id}/`, {
      method: "PUT",
      body: {},
    });
    validateResponse(mutation_schema, response, true);
  }

  async listOffers(query?: OfferQuery): Promise<Offer[]> {
    const body = offerBody(query);
    const response = await this.#http.request("/v0/bundles/", {
      method: "POST",
      body,
      mutating: false,
    });
    const value = validateResponse(
      z.object({ offers: z.array(offer_schema) }),
      response,
    );
    return value.offers.map(normalizeOffer);
  }

  async listRegions(): Promise<Region[]> {
    return unsupported(
      "Vast.ai has no fixed region catalog. Use catalog offers to inspect available GPU offers.",
    );
  }

  async listPlans(_region_id?: string): Promise<Plan[]> {
    return unsupported(
      "Vast.ai uses marketplace offers. Use catalog offers instead of plans.",
    );
  }

  async listImages(): Promise<Image[]> {
    return unsupported(
      "Vast.ai accepts Docker image names. Supply --image with a Docker image when creating an instance.",
    );
  }

  async listSshKeys(): Promise<SshKey[]> {
    return unsupported(
      "Manage SSH keys in your Vast.ai account. Per-instance SSH key selection is not supported by this adapter.",
    );
  }

  async #state(id: string, state: "running" | "stopped"): Promise<void> {
    const response = await this.#http.request(instancePath(id), {
      method: "PUT",
      body: { state },
    });
    validateResponse(mutation_schema, response, true);
  }
}
