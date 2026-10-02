// Tests for the executable itself: run `node bin/lifeline.js` the way a user
// would, and look at the output and the exit code.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { makeGitRepo, makeTempDir, supportYaml } from './helpers.js';

// execFile runs a program without a shell, so nothing can be interpreted by
// one. Wrapping it in a promise lets us `await` it.
const execFileAsync = promisify(execFile);

const BIN = fileURLToPath(new URL('../bin/lifeline.js', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Run the CLI and report how it finished.
 * execFile rejects when the process exits non-zero; that rejection carries the
 * output and the exit code, so we turn it into a normal result here.
 * @param {string[]} args
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
async function lifeline(args) {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [BIN, ...args],
      {
        cwd: REPO_ROOT,
      },
    );
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}

test('lifeline --help runs and explains itself', async () => {
  const { code, stdout } = await lifeline(['--help']);
  assert.equal(code, 0);
  assert.match(stdout, /lifeline/);
  assert.match(stdout, /status/);
});

test('lifeline --version prints the package version', async () => {
  const { code, stdout } = await lifeline(['--version']);
  assert.equal(code, 0);
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+/);
});

test('status reads this repository and exits 0', async () => {
  const { code, stdout } = await lifeline(['status']);
  assert.equal(code, 0);
  assert.match(stdout, /^VERSION {2}STAGE {2}BRANCH/m); // header first
  assert.match(stdout, /^0\.x\s+indev\s+devel/m);
});

test('status --json prints parsable JSON', async () => {
  const { code, stdout } = await lifeline(['status', '--json']);
  assert.equal(code, 0);

  const parsed = JSON.parse(stdout);
  assert.equal(parsed.outcome, 'ok');
  assert.deepEqual(parsed.problems, []);
  assert.equal(parsed.rows[0].version, '0.x');
  assert.equal(parsed.rows[0].stage, 'indev');
  assert.equal(parsed.rows[0].branch, 'devel');
  assert.equal(parsed.rows[0].eol, null);
  assert.equal(parsed.rows[0].daysUntilEol, null);
});

test('--cwd works before and after the command name', async () => {
  const cwd = await makeTempDir({
    'SUPPORT.yaml': supportYaml([{ version: '2.x', stage: 'as' }]),
  });

  const before = await lifeline(['--cwd', cwd, 'status', '--json']);
  const after = await lifeline(['status', '--cwd', cwd, '--json']);

  assert.equal(before.code, 0);
  assert.equal(after.code, 0);
  assert.deepEqual(
    JSON.parse(before.stdout).rows.map((row) => row.version),
    ['2.x'],
  );
  assert.deepEqual(
    JSON.parse(after.stdout).rows.map((row) => row.version),
    ['2.x'],
  );
});

test('a missing SUPPORT.yaml exits 2, a configuration error', async () => {
  const cwd = await makeTempDir();

  const { code, stdout, stderr } = await lifeline(['status', '--cwd', cwd]);

  assert.equal(code, 2);
  assert.equal(stdout, '');
  assert.match(stderr, /error: No SUPPORT\.yaml/);
});

test('a broken SUPPORT.yaml exits 2 but still prints JSON', async () => {
  const cwd = await makeTempDir({ 'SUPPORT.yaml': 'lines: 1\n' });

  const { code, stdout } = await lifeline(['status', '--cwd', cwd, '--json']);

  assert.equal(code, 2);
  const parsed = JSON.parse(stdout);
  assert.deepEqual(parsed.rows, []);
  assert.equal(parsed.problems[0].level, 'error');
});

test('warnings alone still exit 0', async () => {
  // An ls line without an eol date is a warning, not a broken file.
  const cwd = await makeTempDir({
    'SUPPORT.yaml': supportYaml([
      { version: '2.x', stage: 'indev' },
      { version: '1.x', stage: 'ls' },
    ]),
  });

  const { code, stdout, stderr } = await lifeline(['status', '--cwd', cwd]);

  assert.equal(code, 0);
  assert.match(stdout, /^1\.x\s+ls/m);
  assert.match(stderr, /warning: .*has no "eol" date/);
});

test('an unknown command exits 2', async () => {
  const { code } = await lifeline(['nope']);
  assert.equal(code, 2);
});

test('an unknown flag exits 2', async () => {
  const { code } = await lifeline(['status', '--nope']);
  assert.equal(code, 2);
});

test('status shows whether each branch exists', async () => {
  const { stdout } = await lifeline(['status', '--json']);
  assert.equal(JSON.parse(stdout).rows[0].exists, true, 'devel exists here');

  const cwd = await makeTempDir();
  const empty = await lifeline(['status', '--cwd', cwd, '--json']);
  assert.equal(JSON.parse(empty.stdout).rows.length, 0);
});

test('check passes on this repository', async () => {
  const { code, stdout } = await lifeline(['check']);
  assert.equal(code, 0);
  assert.match(stdout, /^OK: /);
});

test('check prints problems on stderr and exits 1', async () => {
  // as/v1.x exists, but the file says 1.x is in Life Support.
  const repo = await makeGitRepo({
    branches: ['as/v2.x', 'as/v1.x'],
    support: supportYaml([
      { version: '2.x', stage: 'as' },
      { version: '1.x', stage: 'ls', eol: '2030-01-01' },
    ]),
  });

  const { code, stdout, stderr } = await lifeline(['check', '--cwd', repo.cwd]);

  assert.equal(code, 1);
  assert.equal(stdout, '');
  assert.match(
    stderr,
    /^error: branch as\/v1\.x exists, but SUPPORT\.yaml says 1\.x is ls/,
  );
});

test('check --strict makes warnings fail', async () => {
  // Everything agrees, except that the ls line has no eol date.
  const repo = await makeGitRepo({
    branches: ['ls/v1.x'],
    support: supportYaml([
      { version: '2.x', stage: 'indev' },
      { version: '1.x', stage: 'ls' },
    ]),
  });

  const plain = await lifeline(['check', '--cwd', repo.cwd]);
  const strict = await lifeline([
    'check',
    '--cwd',
    repo.cwd,
    '--strict',
    '--json',
  ]);

  assert.equal(plain.code, 0);
  assert.match(plain.stderr, /^warning: /m);

  assert.equal(strict.code, 1);
  const parsed = JSON.parse(strict.stdout);
  assert.ok(parsed.problems.length > 0);
  assert.ok(parsed.problems.every((problem) => problem.level === 'error'));
});

test('check --json always prints, even when the file is broken', async () => {
  const cwd = await makeTempDir({ 'SUPPORT.yaml': 'lines: 3\n' });

  const { code, stdout } = await lifeline(['check', '--cwd', cwd, '--json']);

  assert.equal(code, 2);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.outcome, 'ok');
  assert.equal(parsed.problems[0].level, 'error');
  assert.equal(parsed.exitCode, 2);
});

test('check --fetch is accepted and reported in the output', async () => {
  const { code, stdout } = await lifeline(['check', '--fetch', '--json']);
  assert.equal(code, 0);
  assert.equal(JSON.parse(stdout).fetched, true);
});
