import { type Account, validateAccountId } from "../core/accounts.ts";
import { AppError } from "../core/errors.ts";
import type { CliCommand } from "./command.ts";
import type { CommandContext } from "./context.ts";
import {
  type CredentialOptions,
  readCredentials,
  withCredentialOptions,
} from "./credentials.ts";

export function registerLoginCommand(
  program: CliCommand,
  context: CommandContext,
): void {
  const { registry, io, env, storeFor, print } = context;
  const login = withCredentialOptions(
    program
      .command("login [id]")
      .description("Verify credentials and save a named account")
      .option("--provider <id>", "Provider ID (new accounts default to vultr)"),
  );
  login.action(async (supplied_id?: string) => {
    let id = supplied_id;
    if (id === undefined) {
      if (!io.is_interactive || !io.read_text) {
        throw new AppError(
          "invalid_input",
          "Provide an account name: login NAME.",
        );
      }
      id = await io.read_text("Account name");
    }
    validateAccountId(id);
    const flags = login.opts<CredentialOptions & { provider?: string }>();
    const store = storeFor(login);
    const config = await store.read();
    const existing = config.accounts.find((account) => account.id === id);
    const provider_id = flags.provider ?? existing?.provider_id ?? "vultr";
    if (existing && existing.provider_id !== provider_id) {
      throw new AppError(
        "conflict",
        `Account '${id}' uses provider '${existing.provider_id}'. Choose a different account name for '${provider_id}'.`,
      );
    }
    const definition = registry.get(provider_id);
    const account: Account = {
      id,
      provider_id,
      credentials: await readCredentials(definition, io, flags),
    };
    registry.validateAccount(account);
    const instances = await registry.connect(account, env).listInstances();
    await store.save(account);
    print(login, "login", {
      id,
      provider_id,
      status: "authenticated",
      instance_count: instances.length,
    });
  });
}
