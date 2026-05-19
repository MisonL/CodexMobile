#!/usr/bin/env node
import { runCli } from '../cli/commands.mjs';

const result = await runCli(process.argv.slice(2));
process.exitCode = result.code;
