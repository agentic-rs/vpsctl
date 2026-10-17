#!/usr/bin/env bun
import { runSshPasswordHelper } from "./core/ssh-password.ts";

const args = Bun.argv.slice(2);
const helper_exit = await runSshPasswordHelper(args);
process.exitCode =
  helper_exit ?? (await (await import("./commands/program.ts")).runCli(args));
