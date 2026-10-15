import { Command, Option } from "commander";

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
  override createCommand(name?: string): CliCommand {
    return new CliCommand(name);
  }

  override createOption(flags: string, description?: string): Option {
    return new SnakeCaseOption(flags, description);
  }
}
