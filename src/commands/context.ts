import type { Account, AccountStore } from "../core/accounts.ts";
import type {
  CreateInstanceInput,
  EditInstanceInput,
  InstanceAction,
  Provider,
} from "../core/provider.ts";
import type { ProviderRegistry } from "../core/registry.ts";
import type { CliCommand } from "./command.ts";

export interface PromptOption {
  value: string;
  label: string;
  hint?: string;
}

export interface PromptProgress {
  signal?: AbortSignal;
  stop(message: string): void;
  fail(message: string): void;
}

export interface CliIO {
  write_out(text: string): void;
  write_err(text: string): void;
  is_interactive: boolean;
  confirm(message: string): Promise<boolean>;
  read_text?(message: string): Promise<string>;
  read_secret?(message: string): Promise<string>;
  read_stdin?(): Promise<string>;
  select?(message: string, options: PromptOption[]): Promise<string>;
  intro?(message: string): void;
  outro?(message: string): void;
  note?(message: string, title: string): void;
  progress?(message: string): PromptProgress;
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

interface MutationOperation {
  notice: string;
  execute(provider: Provider): Promise<unknown>;
}

export type Mutation = MutationOperation &
  (
    | {
        action: "instance.create";
        input: CreateInstanceInput;
        instance_id?: never;
      }
    | { action: "instance.edit"; input: EditInstanceInput; instance_id: string }
    | {
        action: `instance.${Exclude<InstanceAction, "create" | "edit">}`;
        input?: never;
        instance_id: string;
      }
  );

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
