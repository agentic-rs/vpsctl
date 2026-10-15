import { createInterface } from "node:readline/promises";
import type { CliIO } from "./context.ts";

async function readLine(message: string): Promise<string> {
  const prompt = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    return await prompt.question(message);
  } finally {
    prompt.close();
  }
}

export const default_io: CliIO = {
  write_out: (text) => process.stdout.write(text),
  write_err: (text) => process.stderr.write(text),
  is_interactive: Boolean(process.stdin.isTTY && process.stderr.isTTY),
  read_text: (message) => readLine(`${message}: `),
  async read_secret(message) {
    const { default: password } = await import("@inquirer/password");
    return password(
      { message, mask: true, toggleMask: false },
      { input: process.stdin, output: process.stderr },
    );
  },
  read_stdin: () => Bun.stdin.text(),
  async confirm(message) {
    return (await readLine(`${message} [y/N] `)).trim().toLowerCase() === "y";
  },
};
