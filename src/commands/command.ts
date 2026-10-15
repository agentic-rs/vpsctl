import { Command, type HelpContext, Option } from "commander";

// Commander normally uses camelCase for option fields. Keep our command data
// consistent with account configuration, provider inputs, and JSON output.
class SnakeCaseOption extends Option {
  override attributeName(): string {
    return super
      .attributeName()
      .replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  }
}

export class CliCommand extends Command {
  override help(context?: HelpContext): never;
  override help(callback: (text: string) => string): never;
  override help(context?: HelpContext | ((text: string) => string)): never {
    // Commander treats an omitted subcommand as an error. Bare scopes are a
    // useful entry point for discovering their verbs, just like explicit help.
    if (
      typeof context !== "function" &&
      context?.error &&
      this.commands.length > 0 &&
      this.args.length === 0
    ) {
      return super.help();
    }
    if (typeof context === "function") return super.help(context);
    return super.help(context);
  }

  override createCommand(name?: string): CliCommand {
    return new CliCommand(name);
  }

  override createOption(flags: string, description?: string): Option {
    return new SnakeCaseOption(flags, description);
  }
}
