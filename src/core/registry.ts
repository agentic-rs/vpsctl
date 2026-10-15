import {
  RunpodProvider,
  runpod_info,
  validateCreateInput as validateRunpodCreate,
  validateEditInput as validateRunpodEdit,
} from "../providers/runpod/index.ts";
import { parseIdentifier as parseRunpodId } from "../providers/runpod/schemas.ts";
import {
  VastProvider,
  validateCreateInput as validateVastCreate,
  validateEditInput as validateVastEdit,
  vast_info,
} from "../providers/vast/index.ts";
import { instancePath as vastInstancePath } from "../providers/vast/schemas.ts";
import { VultrProvider, vultr_info } from "../providers/vultr/index.ts";
import {
  createBody,
  editBody,
  identifier_schema,
  validateInput,
} from "../providers/vultr/schemas.ts";
import type { Account } from "./accounts.ts";
import { resolveCredentialReferences, resolveCredentials } from "./accounts.ts";
import { AppError } from "./errors.ts";
import type { Provider, ProviderDefinition } from "./provider.ts";

const vultr_definition: ProviderDefinition = {
  info: vultr_info,
  credential_fields: ["api_key"],
  validateInstanceId(id) {
    validateInput(identifier_schema, id);
  },
  validateCreateInput(input) {
    createBody(input);
  },
  validateEditInput(input) {
    editBody(input);
  },
  create(credentials) {
    const api_key = credentials.api_key;
    if (!api_key) {
      throw new AppError(
        "authentication",
        "Vultr requires an api_key credential.",
      );
    }
    return new VultrProvider({ api_key });
  },
};

const runpod_definition: ProviderDefinition = {
  info: runpod_info,
  credential_fields: ["api_key"],
  validateInstanceId(id) {
    parseRunpodId(id);
  },
  validateCreateInput: validateRunpodCreate,
  validateEditInput: validateRunpodEdit,
  create(credentials) {
    const api_key = credentials.api_key;
    if (!api_key) {
      throw new AppError(
        "authentication",
        "RunPod requires an api_key credential.",
      );
    }
    return new RunpodProvider({ api_key });
  },
};

const vast_definition: ProviderDefinition = {
  info: vast_info,
  credential_fields: ["api_key"],
  validateInstanceId(id) {
    vastInstancePath(id);
  },
  validateCreateInput: validateVastCreate,
  validateEditInput: validateVastEdit,
  create(credentials) {
    const api_key = credentials.api_key;
    if (!api_key) {
      throw new AppError(
        "authentication",
        "Vast.ai requires an api_key credential.",
      );
    }
    return new VastProvider({ api_key });
  },
};

export class ProviderRegistry {
  private readonly definitions = new Map<string, ProviderDefinition>();

  constructor(
    definitions: readonly ProviderDefinition[] = [
      vultr_definition,
      runpod_definition,
      vast_definition,
    ],
  ) {
    for (const definition of definitions) {
      const id = definition.info.id;
      if (this.definitions.has(id)) {
        throw new AppError(
          "invalid_input",
          `Provider '${id}' is already registered.`,
        );
      }
      this.definitions.set(id, definition);
    }
  }

  list(): ProviderDefinition[] {
    return [...this.definitions.values()];
  }

  get(id: string): ProviderDefinition {
    const definition = this.definitions.get(id);
    if (!definition) {
      throw new AppError(
        "invalid_input",
        `Unknown provider '${id}'. Run 'provider list'.`,
      );
    }
    return definition;
  }

  validateAccount(account: Account): void {
    this.validateCredentialFields(account.provider_id, account.credentials);
  }

  private validateCredentialFields(
    provider_id: string,
    credentials: Account["credentials"],
  ): void {
    const definition = this.get(provider_id);
    const fields = Object.keys(credentials);
    for (const field of definition.credential_fields) {
      if (!fields.includes(field)) {
        throw new AppError(
          "invalid_input",
          `Provider '${provider_id}' requires credential '${field}'.`,
        );
      }
    }
    for (const field of fields) {
      if (!definition.credential_fields.includes(field)) {
        throw new AppError(
          "invalid_input",
          `Unknown credential '${field}' for provider '${provider_id}'.`,
        );
      }
    }
  }

  connect(
    account: Account,
    env: Readonly<Record<string, string | undefined>>,
  ): Provider {
    this.validateAccount(account);
    return this.get(account.provider_id).create(
      resolveCredentials(account, env),
    );
  }

  connectCredentials(
    provider_id: string,
    credentials: Account["credentials"],
    env: Readonly<Record<string, string | undefined>>,
  ): Provider {
    this.validateCredentialFields(provider_id, credentials);
    return this.get(provider_id).create(
      resolveCredentialReferences(credentials, env),
    );
  }
}
