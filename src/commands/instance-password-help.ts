import type { ProviderInfo } from "../core/provider.ts";
import { sanitizeTerminalText } from "./output.ts";

export function instancePasswordHelp(
  info: ProviderInfo,
  instance_id: string,
): ProviderInfo["instance_password_help"] {
  const help = info.instance_password_help;
  if (help === undefined) return undefined;
  return {
    url: sanitizeTerminalText(
      help.url.replaceAll(
        "{instance_id}",
        encodeURIComponent(instance_id.toWellFormed()),
      ),
    ),
    instructions: sanitizeTerminalText(help.instructions),
  };
}
