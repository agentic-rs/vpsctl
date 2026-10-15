import type { Account, AccountStore } from "../core/accounts.ts";
import type {
  CreateInstanceInput,
  EditInstanceInput,
  InstanceAction,
  Provider,
} from "../core/provider.ts";
import type { ProviderRegistry } from "../core/registry.ts";
import type { CliCommand } from "./command.ts";

export interface CliIO {
  write_out(text: string): void;
  write_err(text: string): void;
  is_interactive: boolean;
  confirm(message: string): Promise<boolean>;
  read_secret?(message: string): Promise<string>;
  read_stdin?(): Promise<string>;
}

export interface CliOptions {
  env?: Readonly<Record<string, string | undefined>>;
  io?: CliIO;
  registry?: ProviderRegistry;
}

export interface CommonOptions {
  config?: string;
  account?: string;
  json?: boolean;
  yes?: boolean;
  dry_run?: boolean;
}

export interface Mutation {
  action: `instance.${InstanceAction}`;
  instance_id?: string;
  input?: CreateInstanceInput | EditInstanceInput;
  notice: string;
  execute(provider: Provider): Promise<unknown>;
}

export interface CommandContext {
  env: Readonly<Record<string, string | undefined>>;
  io: CliIO;
  registry: ProviderRegistry;
  storeFor(command: CliCommand): AccountStore;
  print(
    command: CliCommand,
    action: string,
    data: unknown,
    account?: Account,
  ): void;
  readProvider(
    command: CliCommand,
    action: string,
    execute: (provider: Provider) => Promise<unknown>,
  ): Promise<void>;
  mutate(command: CliCommand, mutation: Mutation): Promise<void>;
  mutationFlags(command: CliCommand): CliCommand;
  setExitCode(code: number): void;
}
