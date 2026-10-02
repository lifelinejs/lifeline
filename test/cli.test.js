// A smoke test for the executable: run `node bin/lifeline.js` as a user would.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

// execFile runs a program without a shell, so no arguments can be interpreted
// by the shell. Wrapping it in a promise lets us `await` it.
const execFileAsync = promisify(execFile);

const BIN = fileURLToPath(new URL('../bin/lifeline.js', import.meta.url));

test('lifeline --help runs and explains itself', async () => {
  const { stdout } = await execFileAsync(process.execPath, [BIN, '--help']);
  assert.match(stdout, /lifeline/);
});

test('lifeline --version prints the package version', async () => {
  const { stdout } = await execFileAsync(process.execPath, [BIN, '--version']);
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+/);
});
