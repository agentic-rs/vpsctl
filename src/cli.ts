#!/usr/bin/env bun
import { runCli } from "./commands/program.ts";

process.exitCode = await runCli(Bun.argv.slice(2));
