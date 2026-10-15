import { Argument } from "commander";
import type { CliCommand } from "./command.ts";
import type { CommandContext } from "./context.ts";

export function registerCredentialCommands(
  program: CliCommand,
  context: CommandContext,
): void {
  const credential = program
    .command("credential")
    .description("Manage connection credentials");
  const list = credential
    .command("list")
    .description("List provider-registered SSH keys")
    .addArgument(
      new Argument("<resource>", "Credential resource").choices(["ssh-key"]),
    );
  list.action(() =>
    context.readProvider(list, "credential.list.ssh_key", (provider) =>
      provider.listSshKeys(),
    ),
  );
}
