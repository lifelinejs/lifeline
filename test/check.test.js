// Tests for src/commands/check.js and the repo-aware rules in
// src/core/checks.js.
//
// Most tests use a fake git object, so the rules can be read in isolation. The
// last few build real repositories and run the real commands.

import test from 'node:test';
import assert from 'node:assert/strict';

import { check } from '../src/commands/check.js';
import { createGit } from '../src/git/git.js';
import { makeGitRepo, makeTempDir, supportYaml } from './helpers.js';

/** A fixed "today", so day counts do not move while we read this file. */
const NOW = new Date('2026-01-15T12:00:00Z');

/**
 * A stand-in for src/git/git.js. It records whether it was asked to fetch.
 * @param {{branches?: string[], tags?: string[], failWith?: string}} [options]
 */
function fakeGit({ branches = ['devel'], tags = [], failWith = null } = {}) {
  const calls = { fetchRemote: 0 };
  const fail = () => {
    throw new Error(failWith);
  };
  return {
    calls,
    branches: async () => (failWith ? fail() : branches),
    tags: async () => (failWith ? fail() : tags),
    isClean: async () => true,
    fetchRemote: async () => {
      calls.fetchRemote += 1;
      if (failWith) {
        fail();
      }
    },
    run: async () => '',
  };
}

/** Only the error-level messages. */
function errors(problems) {
  return problems
    .filter((problem) => problem.level === 'error')
    .map((p) => p.message);
}

/** Only the warning-level messages. */
function warnings(problems) {
  return problems
    .filter((problem) => problem.level === 'warning')
    .map((p) => p.message);
}

test('a healthy repository has no problems', async () => {
  const cwd = await makeTempDir({
    'SUPPORT.yaml': supportYaml([
      { version: '2.x', stage: 'indev' },
      { version: '1.x', stage: 'as' },
      { version: '0.x', stage: 'ls', eol: '2030-01-01' },
    ]),
  });
  const git = fakeGit({ branches: ['devel', 'as/v1.x', 'ls/v0.x'], tags: [] });

  const result = await check({ cwd, git, now: NOW });

  assert.deepEqual(result.problems, []);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.counts, { lines: 3, branches: 3, tags: 0 });
});

test('error: a support branch that SUPPORT.yaml does not list', async () => {
  const cwd = await makeTempDir({
    'SUPPORT.yaml': supportYaml([{ version: '2.x', stage: 'indev' }]),
  });
  const git = fakeGit({ branches: ['devel', 'as/v1.x'] });

  const result = await check({ cwd, git, now: NOW });

  assert.equal(result.exitCode, 1);
  assert.deepEqual(errors(result.problems), [
    'branch as/v1.x exists, but 1.x is not listed in SUPPORT.yaml.',
  ]);
});

test('error: a branch ahead of the stage in SUPPORT.yaml', async () => {
  const cwd = await makeTempDir({
    'SUPPORT.yaml': supportYaml([{ version: '1.x', stage: 'as' }]),
  });
  const git = fakeGit({ branches: ['devel', 'as/v1.x', 'ls/v1.x'] });

  const result = await check({ cwd, git, now: NOW });

  assert.equal(result.exitCode, 1);
  assert.deepEqual(errors(result.problems), [
    'branch ls/v1.x exists, but SUPPORT.yaml says 1.x is as; promote 1.x or update the file.',
  ]);
});

test('an earlier-stage branch is history, not a mismatch', async () => {
  const cwd = await makeTempDir({
    'SUPPORT.yaml': supportYaml([
      { version: '1.x', stage: 'el', eol: '2024-01-01' },
    ]),
  });
  const git = fakeGit({
    branches: ['devel', 'ls/v1.x', 'el/v1.x'],
    tags: ['v1.x-eol'],
  });

  const result = await check({ cwd, git, now: NOW });

  assert.equal(result.exitCode, 0, errors(result.problems).join('\n'));
});

test('warning: a listed line whose branch does not exist yet', async () => {
  const cwd = await makeTempDir({
    'SUPPORT.yaml': supportYaml([
      { version: '2.x', stage: 'indev' },
      { version: '1.x', stage: 'as' },
    ]),
  });
  const git = fakeGit({ branches: ['devel'] });

  const result = await check({ cwd, git, now: NOW });

  assert.equal(result.exitCode, 0, 'a missing branch is only a warning');
  assert.deepEqual(warnings(result.problems), [
    'as/v1.x does not exist yet; branches may be created lazily.',
  ]);
});

test('warning: an el line is not expected to have a branch', async () => {
  const cwd = await makeTempDir({
    'SUPPORT.yaml': supportYaml([{ version: '0.x', stage: 'el' }]),
  });
  const git = fakeGit({ branches: ['devel'], tags: ['v0.x-eol'] });

  const result = await check({ cwd, git, now: NOW });

  assert.deepEqual(result.problems, []);
});

test('warning: an eol date in the past on a line that is not el', async () => {
  const cwd = await makeTempDir({
    'SUPPORT.yaml': supportYaml([
      { version: '1.x', stage: 'ls', eol: '2025-06-01' },
    ]),
  });
  const git = fakeGit({ branches: ['devel', 'ls/v1.x'] });

  const result = await check({ cwd, git, now: NOW });

  assert.match(
    warnings(result.problems)[0],
    /passed its eol date of 2025-06-01 228 days ago/,
  );
});

test('warning: an el line without a vN.x-eol tag', async () => {
  const cwd = await makeTempDir({
    'SUPPORT.yaml': supportYaml([{ version: '0.x', stage: 'el' }]),
  });
  const git = fakeGit({ branches: ['devel'], tags: [] });

  const result = await check({ cwd, git, now: NOW });

  assert.deepEqual(warnings(result.problems), [
    '"0.x" is at stage el, but there is no v0.x-eol tag.',
  ]);
});

test('no eol-tag warning when the tag exists', async () => {
  const cwd = await makeTempDir({
    'SUPPORT.yaml': supportYaml([{ version: '0.x', stage: 'el' }]),
  });
  const git = fakeGit({ branches: ['devel'], tags: ['v0.x-eol', 'v1.0.0'] });

  const result = await check({ cwd, git, now: NOW });

  assert.deepEqual(result.problems, []);
});

test('--strict presents warnings as errors and fails', async () => {
  const cwd = await makeTempDir({
    'SUPPORT.yaml': supportYaml([
      { version: '2.x', stage: 'indev' },
      { version: '1.x', stage: 'as' },
    ]),
  });
  const git = fakeGit({ branches: ['devel'] });

  const result = await check({ cwd, git, strict: true, now: NOW });

  assert.equal(result.exitCode, 1);
  assert.deepEqual(errors(result.problems), [
    'as/v1.x does not exist yet; branches may be created lazily.',
  ]);
});

test('check does not fetch unless it is asked to', async () => {
  const cwd = await makeTempDir({
    'SUPPORT.yaml': supportYaml([{ version: '2.x', stage: 'indev' }]),
  });
  const quiet = fakeGit();
  const noisy = fakeGit();

  await check({ cwd, git: quiet, now: NOW });
  await check({ cwd, git: noisy, fetch: true, now: NOW });

  assert.equal(quiet.calls.fetchRemote, 0);
  assert.equal(noisy.calls.fetchRemote, 1);
});

test('a git failure becomes a problem, not a crash', async () => {
  const cwd = await makeTempDir({
    'SUPPORT.yaml': supportYaml([{ version: '2.x', stage: 'indev' }]),
  });
  const git = fakeGit({ failWith: 'not a git repository' });

  const result = await check({ cwd, git, now: NOW });

  assert.equal(result.exitCode, 1);
  assert.match(
    errors(result.problems)[0],
    /Could not read the repository: not a git repository/,
  );
});

test('a missing SUPPORT.yaml is a configuration error: exit 2', async () => {
  const cwd = await makeTempDir();
  const git = fakeGit();

  const result = await check({ cwd, git, now: NOW });

  assert.equal(result.exitCode, 2);
  assert.match(result.problems[0].message, /No SUPPORT\.yaml/);
});

test('an unparsable SUPPORT.yaml is a configuration error: exit 2', async () => {
  const cwd = await makeTempDir({
    'SUPPORT.yaml': 'lines:\n  - version: "2.1"\n    stage: as\n',
  });
  const git = fakeGit();

  const result = await check({ cwd, git, now: NOW });

  assert.equal(result.exitCode, 2);
  assert.match(result.problems[0].message, /needs a "version" string/);
});

// Integration tests below: real repositories, real git commands.

test('integration: a repository whose file and branches agree', async () => {
  const { cwd } = await makeGitRepo({
    branches: ['as/v2.x', 'ls/v1.x'],
    support: supportYaml([
      { version: '3.x', stage: 'indev' },
      { version: '2.x', stage: 'as' },
      { version: '1.x', stage: 'ls', eol: '2030-01-01' },
    ]),
  });

  const result = await check({ cwd, git: createGit({ cwd }), now: NOW });

  assert.deepEqual(result.problems, []);
  assert.equal(result.exitCode, 0);
});

test('integration: an extra branch in the repository is an error', async () => {
  const { cwd } = await makeGitRepo({
    // ls/v0.x is left over from an older line and is not in the file.
    branches: ['as/v2.x', 'ls/v1.x', 'ls/v0.x'],
    support: supportYaml([
      { version: '2.x', stage: 'as' },
      { version: '1.x', stage: 'ls', eol: '2030-01-01' },
    ]),
  });

  const result = await check({ cwd, git: createGit({ cwd }), now: NOW });

  assert.equal(result.exitCode, 1);
  assert.match(
    errors(result.problems)[0],
    /branch ls\/v0\.x exists, but 0\.x is not listed/,
  );
});

test('integration: a branch only on the remote still counts as existing', async () => {
  const { cwd } = await makeGitRepo({
    branches: ['as/v2.x'],
    withRemote: true,
    support: supportYaml([{ version: '2.x', stage: 'as' }]),
  });

  const result = await check({ cwd, git: createGit({ cwd }), now: NOW });

  assert.deepEqual(result.problems, []);
});
