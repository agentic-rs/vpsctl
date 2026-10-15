import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliCommand } from "../src/commands/command.ts";
import { type CliIO, runCli } from "../src/commands/program.ts";
import { ProviderRegistry } from "../src/core/registry.ts";

const temp_dirs: string[] = [];

async function fixture() {
  const temp_dir = await mkdtemp(join(tmpdir(), "vps-ctl-command-help-"));
  temp_dirs.push(temp_dir);
  let connections = 0;
  let prompts = 0;
  const registry = new ProviderRegistry([
    {
      info: { id: "example", name: "Example Provider", capabilities: [] },
      credential_fields: ["api_key"],
      create() {
        connections += 1;
        throw new Error("Help must not connect to a provider.");
      },
    },
  ]);
  const run = async (argv: string[]) => {
    const output: string[] = [];
    const errors: string[] = [];
    const rejectPrompt = async (): Promise<never> => {
      prompts += 1;
      throw new Error("Help must not prompt for input.");
    };
    const io: CliIO = {
      is_interactive: true,
      write_out: (text) => output.push(text),
      write_err: (text) => errors.push(text),
      confirm: rejectPrompt,
      read_text: rejectPrompt,
      read_secret: rejectPrompt,
      read_stdin: rejectPrompt,
      select: rejectPrompt,
    };
    // A directory cannot be parsed as account configuration, so even an
    // accidental configuration read makes these help commands fail.
    const exit_code = await runCli(["--config", temp_dir, ...argv], {
      env: {},
      io,
      registry,
    });
    expect(connections).toBe(0);
    expect(prompts).toBe(0);
    return {
      exit_code,
      stdout: output.join(""),
      stderr: errors.join(""),
    };
  };
  return { run };
}

afterEach(async () => {
  await Promise.all(
    temp_dirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("scope usage", () => {
  for (const scope of ["auth", "provider", "instance", "spec", "credential"]) {
    test(`shows ${scope} usage when no verb is supplied`, async () => {
      const { run } = await fixture();
      for (const argv of [
        [scope],
        [scope, "--json"],
        ["--json", scope],
        ["--account", "unselected", scope],
      ]) {
        const result = await run(argv);
        expect(result.exit_code).toBe(0);
        expect(result.stdout).toContain(`Usage: vps-ctl ${scope}`);
        expect(result.stdout).toContain("Commands:");
        expect(result.stderr).toBe("");
      }
    });

    test(`preserves explicit ${scope} help and rejects unknown verbs and flags`, async () => {
      const { run } = await fixture();
      const help = await run([scope, "--help"]);
      expect(help.exit_code).toBe(0);
      expect(help.stdout).toContain(`Usage: vps-ctl ${scope}`);
      expect(help.stderr).toBe("");

      for (const argv of [
        [scope, "unknown-verb"],
        [scope, "--unknown-flag"],
        [scope, "unknown-verb", "--json"],
        [scope, "--unknown-flag", "--json"],
      ]) {
        const result = await run(argv);
        expect(result.exit_code).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).not.toContain("(outputHelp)");
        if (argv.includes("--json")) {
          expect(JSON.parse(result.stderr)).toMatchObject({
            error: { code: "invalid_input", message: expect.any(String) },
          });
        } else {
          expect(result.stderr).toContain("Error:");
          expect(result.stderr).toContain(
            argv.includes("unknown-verb")
              ? "unknown command 'unknown-verb'"
              : "unknown option '--unknown-flag'",
          );
        }
      }
    });
  }

  test("shows root usage and keeps leaf argument validation", async () => {
    const { run } = await fixture();
    for (const argv of [
      [],
      ["--help"],
      ["--json"],
      ["--account", "unselected"],
      ["--json", "--account", "unselected"],
    ]) {
      const result = await run(argv);
      expect(result.exit_code).toBe(0);
      expect(result.stdout).toContain("Usage: vps-ctl");
      expect(result.stderr).toBe("");
    }
    for (const argv of [
      ["auth", "login", "--help"],
      ["instance", "create", "--help"],
      ["spec", "list", "--help"],
      ["credential", "list", "--help", "--json"],
    ]) {
      const result = await run(argv);
      expect(result.exit_code).toBe(0);
      expect(result.stdout).toContain(`Usage: vps-ctl ${argv[0]} ${argv[1]}`);
      expect(result.stderr).toBe("");
    }
    for (const argv of [
      ["instance", "get"],
      ["instance", "destroy", "--json"],
      ["auth", "remove"],
      ["spec", "list"],
      ["credential", "list", "--json"],
    ]) {
      const result = await run(argv);
      expect(result.exit_code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("missing required argument");
    }
    for (const argv of [
      ["unknown-scope"],
      ["--unknown-flag"],
      ["--config"],
      ["--account"],
    ]) {
      const result = await run(argv);
      expect(result.exit_code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Error:");
      expect(result.stderr).not.toContain("(outputHelp)");
    }
  });

  test("applies to nested scopes without hiding invalid nested commands", async () => {
    for (const argv of [
      ["outer"],
      ["outer", "inner"],
      ["outer", "inner", "--json"],
    ]) {
      const output: string[] = [];
      const program = new CliCommand()
        .name("example-cli")
        .option("--json")
        .exitOverride()
        .configureOutput({ writeOut: (text) => output.push(text) });
      program.command("outer").command("inner").command("list");
      expect(() => program.parse(argv, { from: "user" })).toThrow(
        expect.objectContaining({ exitCode: 0 }),
      );
      expect(output.join("")).toContain("Usage: example-cli outer");
    }
    for (const argv of [
      ["outer", "unknown-verb"],
      ["outer", "inner", "unknown-verb"],
      ["outer", "inner", "--unknown-flag"],
    ]) {
      const output: string[] = [];
      const program = new CliCommand()
        .name("example-cli")
        .exitOverride()
        .configureOutput({
          writeOut: (text) => output.push(text),
          writeErr: () => {},
        });
      program.command("outer").command("inner").command("list");
      expect(() => program.parse(argv, { from: "user" })).toThrow(
        expect.objectContaining({ exitCode: 1 }),
      );
      expect(output).toEqual([]);
    }
  });
});
