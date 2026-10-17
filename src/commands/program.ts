import { CommanderError } from "commander";
import {
  type Account,
  AccountStore,
  accountDisplayId,
  defaultConfigPath,
  resolveAccount,
} from "../core/accounts.ts";
import { createCtlClient } from "../core/ctl.ts";
import { AppError } from "../core/errors.ts";
import {
  InstanceCredentialStore,
  instanceCredentialPath,
} from "../core/instance-credentials.ts";
import type {
  CreateInstanceInput,
  InstanceAction,
  InstanceLoginCredential,
  Provider,
} from "../core/provider.ts";
import { ProviderRegistry } from "../core/registry.ts";
import { registerAuthCommands } from "./auth.ts";
import { CliCommand } from "./command.ts";
import type {
  CliOptions,
  CommandContext,
  CommonOptions,
  Mutation,
} from "./context.ts";
import { type CreateReview, prepareCreate } from "./create.ts";
import { registerCredentialCommands } from "./credential.ts";
import { nonblank } from "./input.ts";
import { registerInstanceCommands } from "./instances.ts";
import { default_io } from "./io.ts";
import { render, sanitizeTerminalText } from "./output.ts";
import { registerProviderCommands } from "./provider.ts";
import { registerSpecCommands } from "./spec.ts";

export type { CliIO, CliOptions } from "./context.ts";

function creationPasswordWarning(provider: Provider): string {
  const help = provider.info.instance_password_help;
  const guidance = help
    ? `Retrieve it from the provider website at ${sanitizeTerminalText(help.url)}. ${sanitizeTerminalText(help.instructions)}`
    : "Retrieve it from this instance's Overview page on the provider website.";
  return `The instance was created, but its login password could not be saved. ${guidance} Run instance login in an interactive terminal to enter and save it.`;
}

export async function runCli(
  argv: string[],
  options: CliOptions = {},
): Promise<number> {
  const env = options.env ?? process.env;
  const io = options.io ?? default_io;
  const registry = options.registry ?? new ProviderRegistry();
  let exit_code = 0;
  const program = new CliCommand()
    .name("vpsctl")
    .description("Manage compute instances across local provider accounts.")
    .version("0.1.0")
    .option("--config <path>", "Account configuration file")
    .option(
      "-a, --account <id>",
      "Account ID or unique provider shortcut (overrides environment/default)",
    )
    .option("--json", "Print structured JSON")
    .exitOverride()
    .configureOutput({ writeOut: io.write_out, writeErr: () => {} });

  const flagsFor = (command: CliCommand): CommonOptions =>
    command.optsWithGlobals<CommonOptions>();
  const configPathFor = (command: CliCommand): string => {
    const path = flagsFor(command).config ?? defaultConfigPath(env);
    nonblank(path, "Config path");
    return path;
  };
  const storeFor = (command: CliCommand): AccountStore =>
    new AccountStore(configPathFor(command));
  const credentialStoreFor = (command: CliCommand): InstanceCredentialStore =>
    new InstanceCredentialStore(instanceCredentialPath(configPathFor(command)));
  const selectedAccount = async (
    command: CliCommand,
    allow_prompt = true,
  ): Promise<{ account: Account; display_id: string }> => {
    const config = await storeFor(command).read();
    const flags = flagsFor(command);
    let account_id =
      flags.account ?? env.VPSCTL_ACCOUNT ?? config.default_account_id;
    if (
      allow_prompt &&
      account_id === undefined &&
      io.is_interactive &&
      !flags.json &&
      io.select &&
      config.accounts.length > 0
    ) {
      account_id = await io.select(
        "Choose an account",
        config.accounts.map((account) => {
          const label = accountDisplayId(account, config.accounts);
          return {
            value: account.id,
            label,
            ...(label === account.provider_id
              ? {}
              : { hint: account.provider_id }),
          };
        }),
      );
    }
    const account = resolveAccount(config, account_id);
    return { account, display_id: accountDisplayId(account, config.accounts) };
  };
  const print = (
    command: CliCommand,
    action: string,
    data: unknown,
    account?: Account,
    display_id?: string,
  ): void => {
    if (flagsFor(command).json) {
      io.write_out(
        `${JSON.stringify(
          {
            ...(account
              ? { account_id: account.id, provider_id: account.provider_id }
              : {}),
            action,
            data,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      if (account)
        io.write_out(
          `Account: ${display_id ?? account.id} (${account.provider_id})\n`,
        );
      io.write_out(`${render(data, { columns: io.output_columns })}\n`);
    }
  };
  const readProvider = async (
    command: CliCommand,
    action: string,
    execute: (provider: Provider) => Promise<unknown>,
  ): Promise<void> => {
    const { account, display_id } = await selectedAccount(command);
    const data = await execute(registry.connect(account, env));
    print(command, action, data, account, display_id);
  };
  const mutate = async (
    command: CliCommand,
    mutation: Mutation,
  ): Promise<void> => {
    const flags = flagsFor(command);
    const { account, display_id } = await selectedAccount(
      command,
      mutation.action !== "instance.create" || !flags.yes,
    );
    registry.validateAccount(account);
    const definition = registry.get(account.provider_id);
    const notice = [
      mutation.notice,
      definition.info.operation_notes?.[
        mutation.action.split(".")[1] as InstanceAction
      ],
    ]
      .filter(Boolean)
      .join(" ");
    let create_input: CreateInstanceInput | undefined;
    let review: CreateReview | undefined;
    let prepared_provider: Provider | undefined;
    if (mutation.instance_id !== undefined) {
      definition.validateInstanceId?.(mutation.instance_id);
    }
    if (mutation.action === "instance.create") {
      create_input = mutation.input;
      if (
        io.is_interactive &&
        io.select &&
        io.read_text &&
        !flags.json &&
        !flags.yes &&
        definition.create_guidance
      ) {
        definition.validateCreateDraft?.(create_input);
        prepared_provider = registry.connect(account, env);
        const prepared = await prepareCreate(
          create_input,
          definition.create_guidance,
          io,
          prepared_provider,
          {
            account_name: display_id,
            notice,
            dry_run: Boolean(flags.dry_run),
            ...(definition.validateCreateInput
              ? { validate_input: definition.validateCreateInput }
              : {}),
          },
        );
        create_input = prepared.input;
        review = prepared.review;
      }
      definition.validateCreateInput?.(create_input);
    } else if (mutation.action === "instance.edit") {
      definition.validateEditInput?.(mutation.input);
    }
    const preview = {
      account_id: flags.json ? account.id : display_id,
      provider_id: account.provider_id,
      action: mutation.action,
      ...(mutation.instance_id ? { instance_id: mutation.instance_id } : {}),
      ...((create_input ?? mutation.input)
        ? { input: create_input ?? mutation.input }
        : {}),
      notice,
    };
    if (flags.dry_run) {
      print(command, mutation.action, { ...preview, dry_run: true });
      return;
    }
    if (!flags.yes) {
      if (
        !io.is_interactive ||
        (flags.json && mutation.action === "instance.create")
      ) {
        throw new AppError(
          "invalid_input",
          flags.json && mutation.action === "instance.create"
            ? "JSON creation requires --yes. Use --dry-run to preview."
            : "Changes require --yes in noninteractive mode. Use --dry-run to preview.",
        );
      }
      if (review === undefined) {
        io.write_err(`${JSON.stringify(preview, null, 2)}\n`);
      }
      if (
        !(await io.confirm(
          review ? "Create this billable instance?" : "Apply this change?",
        ))
      ) {
        print(
          command,
          mutation.action,
          { status: "cancelled" },
          account,
          display_id,
        );
        return;
      }
    }
    const provider = prepared_provider ?? registry.connect(account, env);
    let data: unknown;
    let credential_warning: string | undefined;
    if (mutation.action === "instance.create") {
      let captured:
        | { instance_id: string; credential: InstanceLoginCredential }
        | undefined;
      const created = await provider.createInstance(
        create_input ?? mutation.input,
        {
          on_login_credential(instance_id, credential) {
            captured = { instance_id, credential };
          },
        },
      );
      data = created;
      try {
        if (created.provider_id !== account.provider_id) {
          throw new AppError(
            "invalid_response",
            "The created instance belongs to a different provider.",
          );
        }
        const credential =
          captured?.instance_id === created.id
            ? captured.credential
            : await provider.getInstanceLoginCredential?.(created.id);
        if (credential !== undefined) {
          await credentialStoreFor(command).set(
            {
              provider_id: account.provider_id,
              account_id: account.id,
              instance_id: created.id,
            },
            credential,
          );
        } else if (provider.getInstanceLoginCredential !== undefined) {
          credential_warning = creationPasswordWarning(provider);
        }
      } catch {
        credential_warning = creationPasswordWarning(provider);
      }
    } else {
      data = await mutation.execute(provider);
      if (mutation.action === "instance.destroy") {
        try {
          await credentialStoreFor(command).remove({
            provider_id: account.provider_id,
            account_id: account.id,
            instance_id: mutation.instance_id,
          });
        } catch {
          credential_warning =
            "The instance was destroyed, but its saved login password could not be removed.";
        }
      }
    }
    print(
      command,
      mutation.action,
      data ?? { status: "accepted", instance_id: mutation.instance_id },
      account,
      display_id,
    );
    if (credential_warning !== undefined) {
      io.write_err(`Warning: ${credential_warning}\n`);
    }
  };
  const mutationFlags = (command: CliCommand): CliCommand =>
    command
      .option("--dry-run", "Preview without applying changes")
      .option("-y, --yes", "Confirm this change without prompting");

  const context: CommandContext = {
    env,
    io,
    registry,
    ctl: options.ctl ?? createCtlClient(env),
    storeFor,
    credentialStoreFor,
    selectedAccount,
    print,
    readProvider,
    mutate,
    mutationFlags,
    setExitCode(code) {
      exit_code = code;
    },
  };
  registerAuthCommands(program, context);
  registerProviderCommands(program, context);
  registerSpecCommands(program, context);
  registerCredentialCommands(program, context);
  registerInstanceCommands(program, context);

  try {
    await program.parseAsync(argv.length ? argv : ["--help"], { from: "user" });
    return exit_code;
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) return 0;
    const code = error instanceof AppError ? error.code : "invalid_input";
    const message = error instanceof Error ? error.message : "Command failed.";
    if (program.opts<CommonOptions>().json || argv.includes("--json")) {
      io.write_err(`${JSON.stringify({ error: { code, message } })}\n`);
    } else {
      io.write_err(`Error: ${message}\n`);
    }
    return code === "cancelled" ? 130 : 1;
  }
}
