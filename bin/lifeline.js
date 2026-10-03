#!/usr/bin/env node
// Entry point for the `lifeline` command.
//
// The shebang line must be the very first line: it tells the OS to run this
// file with node. `npm` turns this file into the executable `lifeline` command
// because package.json lists it under "bin".

import { runCli } from '../src/cli.js';

await runCli(process.argv);
