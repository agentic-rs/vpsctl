import type { Account } from "../core/accounts.ts";
import { AppError } from "../core/errors.ts";
import type { ProviderDefinition } from "../core/provider.ts";
import type { CommandContext } from "./context.ts";

interface ProviderSelectionOptions {
  provider_id?: string | undefined;
  account_id?: string | undefined;
  existing_account?: Account | undefined;
  allow_prompt: boolean;
  fallback_provider_id?: string;
}

export async function resolveProvider(
  context: Pick<CommandContext, "registry" | "io">,
  options: ProviderSelectionOptions,
): Promise<ProviderDefinition> {
  const { registry, io } = context;
  const id_provider = options.account_id?.includes(":")
    ? options.account_id.split(":")[0]
    : undefined;
  let provider_id =
    options.provider_id ?? options.existing_account?.provider_id ?? id_provider;
  if (
    provider_id === undefined &&
    options.allow_prompt &&
    io.is_interactive &&
    io.select
  ) {
    provider_id = await io.select(
      "Choose a provider",
      registry.list().map(({ info }) => ({
        value: info.id,
        label: info.name,
        hint: info.id,
      })),
    );
  }
  provider_id ??= options.fallback_provider_id;
  if (provider_id === undefined) {
    throw new AppError(
      "invalid_input",
      "Specify --provider, or choose a provider in an interactive terminal.",
    );
  }
  if (
    options.existing_account &&
    options.existing_account.provider_id !== provider_id
  ) {
    throw new AppError(
      "conflict",
      `Account '${options.existing_account.id}' uses provider '${options.existing_account.provider_id}'. Choose a different account ID for '${provider_id}'.`,
    );
  }
  if (id_provider !== undefined && id_provider !== provider_id) {
    throw new AppError(
      "invalid_input",
      "The account ID prefix must match the selected provider.",
    );
  }
  return registry.get(provider_id);
}
