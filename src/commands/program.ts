import { CommanderError } from "commander";
import {
  type Account,
  AccountStore,
  accountDisplayId,
  defaultConfigPath,
  resolveAccount,
} from "../core/accounts.ts";
import { AppError } from "../core/errors.ts";
import type { InstanceAction, Provider } from "../core/provider.ts";
import { ProviderRegistry } from "../core/registry.ts";
import { registerAuthCommands } from "./auth.ts";
import { CliCommand } from "./command.ts";
import type {
  CliOptions,
  CommandContext,
  CommonOptions,
  Mutation,
} from "./context.ts";
import { registerCredentialCommands } from "./credential.ts";
import { nonblank } from "./input.ts";
import { registerInstanceCommands } from "./instances.ts";
import { default_io } from "./io.ts";
import { render } from "./output.ts";
import { registerProviderCommands } from "./provider.ts";
import { registerSpecCommands } from "./spec.ts";

export type { CliIO, CliOptions } from "./context.ts";

export async function runCli(
  argv: string[],
  options: CliOptions = {},
): Promise<number> {
  const env = options.env ?? process.env;
  const io = options.io ?? default_io;
  const registry = options.registry ?? new ProviderRegistry();
  let exit_code = 0;
  const program = new CliCommand()
    .name("vps-ctl")
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
  const storeFor = (command: CliCommand): AccountStore => {
    const path = flagsFor(command).config ?? defaultConfigPath(env);
    nonblank(path, "Config path");
    return new AccountStore(path);
  };
  const selectedAccount = async (
    command: CliCommand,
  ): Promise<{ account: Account; display_id: string }> => {
    const config = await storeFor(command).read();
    const flags = flagsFor(command);
    let account_id =
      flags.account ?? env.VPS_CTL_ACCOUNT ?? config.default_account_id;
    if (
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
    const { account, display_id } = await selectedAccount(command);
    const flags = flagsFor(command);
    registry.validateAccount(account);
    const definition = registry.get(account.provider_id);
    if (mutation.instance_id !== undefined) {
      definition.validateInstanceId?.(mutation.instance_id);
    }
    if (mutation.action === "instance.create") {
      definition.validateCreateInput?.(mutation.input);
    } else if (mutation.action === "instance.edit") {
      definition.validateEditInput?.(mutation.input);
    }
    const preview = {
      account_id: flags.json ? account.id : display_id,
      provider_id: account.provider_id,
      action: mutation.action,
      ...(mutation.instance_id ? { instance_id: mutation.instance_id } : {}),
      ...(mutation.input ? { input: mutation.input } : {}),
      notice: [
        mutation.notice,
        definition.info.operation_notes?.[
          mutation.action.split(".")[1] as InstanceAction
        ],
      ]
        .filter(Boolean)
        .join(" "),
    };
    if (flags.dry_run) {
      print(command, mutation.action, { ...preview, dry_run: true });
      return;
    }
    if (!flags.yes) {
      if (!io.is_interactive) {
        throw new AppError(
          "invalid_input",
          "Changes require --yes in noninteractive mode. Use --dry-run to preview.",
        );
      }
      io.write_err(`${JSON.stringify(preview, null, 2)}\n`);
      if (!(await io.confirm("Apply this change?"))) {
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
    const data = await mutation.execute(registry.connect(account, env));
    print(
      command,
      mutation.action,
      data ?? { status: "accepted", instance_id: mutation.instance_id },
      account,
      display_id,
    );
  };
  const mutationFlags = (command: CliCommand): CliCommand =>
    command
      .option("--dry-run", "Preview without credentials or provider requests")
      .option("-y, --yes", "Confirm this change without prompting");

  const context: CommandContext = {
    env,
    io,
    registry,
    storeFor,
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
