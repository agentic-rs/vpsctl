import {
  type Account,
  deriveAccountId,
  validateAccountId,
} from "../core/accounts.ts";
import { AppError } from "../core/errors.ts";
import type { Provider, ProviderRequestOptions } from "../core/provider.ts";
import type { CliCommand } from "./command.ts";
import type { CommandContext, CommonOptions } from "./context.ts";
import {
  type CredentialOptions,
  readCredentials,
  withCredentialOptions,
} from "./credentials.ts";
import { resolveProvider } from "./providers.ts";

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AppError("cancelled", "Operation cancelled.");
}

async function withCancellation<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return operation();
  checkCancelled(signal);
  let on_abort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    on_abort = () => reject(new AppError("cancelled", "Operation cancelled."));
    signal.addEventListener("abort", on_abort, { once: true });
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        checkCancelled(signal);
        return operation();
      }),
      cancelled,
    ]);
  } finally {
    signal.removeEventListener("abort", on_abort);
  }
}

async function verifyIdentity(
  provider: Provider,
  provider_id: string,
  supplied_id?: string,
  options?: ProviderRequestOptions,
): Promise<{ id: string; instance_count: number }> {
  let id = supplied_id;
  if (id === undefined || id.includes(":")) {
    if (!provider.getAccountMetadata) {
      throw new AppError(
        "unsupported_operation",
        `Provider '${provider_id}' cannot derive an account ID. Supply an explicit ID with login NAME.`,
      );
    }
    const metadata = await provider.getAccountMetadata(options);
    const derived_id = deriveAccountId(provider_id, metadata.email);
    if (id !== undefined && id !== derived_id) {
      throw new AppError(
        "conflict",
        "These credentials belong to a different account than the supplied provider:email ID.",
      );
    }
    id = derived_id;
  }
  checkCancelled(options?.signal);
  const instances = await provider.listInstances(options);
  checkCancelled(options?.signal);
  return { id, instance_count: instances.length };
}

export function registerLoginCommand(
  program: CliCommand,
  context: CommandContext,
): void {
  const { registry, io, env, storeFor, print } = context;
  const login = withCredentialOptions(
    program
      .command("login [id]")
      .description(
        "Connect an account; defaults to provider:email after verification",
      )
      .option(
        "--provider <id>",
        "Provider ID (choose interactively, or default to vultr)",
      ),
  );
  login.action(async (supplied_id?: string) => {
    if (supplied_id !== undefined) validateAccountId(supplied_id);
    const flags = login.optsWithGlobals<
      CredentialOptions & CommonOptions & { provider?: string }
    >();
    const store = storeFor(login);
    const config = await store.read();
    const existing = config.accounts.find(
      (account) => account.id === supplied_id,
    );
    const guided =
      io.is_interactive &&
      !flags.json &&
      !flags.credentials_stdin &&
      flags.credential.length === 0;
    if (guided) io.intro?.("Connect a VPS account");
    const definition = await resolveProvider(context, {
      provider_id: flags.provider,
      account_id: supplied_id,
      existing_account: existing,
      allow_prompt: !flags.json && !flags.credentials_stdin,
      fallback_provider_id: "vultr",
    });
    const provider_id = definition.info.id;
    const credentials = await readCredentials(definition, io, flags);
    const provider = registry.connectCredentials(provider_id, credentials, env);
    const progress = guided
      ? io.progress?.("Verifying account access")
      : undefined;
    let verified: { id: string; instance_count: number };
    try {
      verified = await withCancellation(
        () =>
          verifyIdentity(
            provider,
            provider_id,
            supplied_id,
            progress?.signal ? { signal: progress.signal } : undefined,
          ),
        progress?.signal,
      );
      checkCancelled(progress?.signal);
      progress?.stop("Account access verified");
    } catch (error) {
      if (!progress?.signal?.aborted)
        progress?.fail("Could not verify account access");
      throw error;
    }
    const account: Account = {
      id: verified.id,
      provider_id,
      credentials,
    };
    registry.validateAccount(account);
    checkCancelled(progress?.signal);
    await store.save(account);
    if (guided && io.note && io.outro) {
      io.note(
        `Account ID: ${account.id}\nInstances: ${verified.instance_count}`,
        "Account saved",
      );
      io.outro("Your account is ready.");
      return;
    }
    print(login, "login", {
      id: account.id,
      provider_id,
      status: "authenticated",
      instance_count: verified.instance_count,
    });
  });
}
