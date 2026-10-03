// Tests for `lifeline init`: guessing lines from branches, writing the file,
// and refusing to clobber an existing one.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { check } from '../src/commands/check.js';
import { init, starterLines } from '../src/commands/init.js';
import { linesFromBranches } from '../src/core/discover.js';
import { createGit } from '../src/git/git.js';
import {
  createSupport,
  SCHEMA_URL,
  writeSupport,
} from '../src/support-file.js';
import { parseSupport } from '../src/core/support.js';
import { git, holdSupportLock, makeGitRepo, makeTempDir } from './helpers.js';

/** A git stand-in that always answers with the same branch list. */
function fakeGit(branches) {
  return {
    branches: async () => branches,
    tags: async () => [],
    isClean: async () => true,
    fetchRemote: async () => {},
    run: async () => '',
  };
}

test('devel on its own becomes a 1.x line in development', () => {
  assert.deepEqual(linesFromBranches(['devel']), [
    { version: '1.x', stage: 'indev' },
  ]);
});

test('support branches become the lines they name', () => {
  assert.deepEqual(linesFromBranches(['as/v2.x', 'ls/v1.x']), [
    { version: '2.x', stage: 'as' },
    { version: '1.x', stage: 'ls' },
  ]);
});

test('devel sits above the newest support branch', () => {
  assert.deepEqual(linesFromBranches(['as/v2.x', 'devel']), [
    { version: '3.x', stage: 'indev' },
    { version: '2.x', stage: 'as' },
  ]);
});

test('no devel means no line in development', () => {
  assert.deepEqual(linesFromBranches(['as/v2.x']), [
    { version: '2.x', stage: 'as' },
  ]);
});

test('branches that are not support branches are ignored', () => {
  const branches = [
    'devel',
    'main',
    'feature/cool-thing',
    'backport/v1.x/abc1234',
    'as/v2.x',
  ];

  assert.deepEqual(linesFromBranches(branches), [
    { version: '3.x', stage: 'indev' },
    { version: '2.x', stage: 'as' },
  ]);
});

test('two branches for one version keep the stage furthest along', () => {
  assert.deepEqual(linesFromBranches(['as/v1.x', 'el/v1.x']), [
    { version: '1.x', stage: 'el' },
  ]);
  assert.deepEqual(linesFromBranches(['ls/v1.x', 'as/v1.x']), [
    { version: '1.x', stage: 'ls' },
  ]);
});

test('nothing at all gives the starter lines', () => {
  assert.deepEqual(linesFromBranches(['main', 'docs/typo']), []);
  assert.deepEqual(starterLines(), [{ version: '1.x', stage: 'indev' }]);
});

test('the written file starts with the schema comment and parses', async () => {
  const cwd = await makeTempDir();

  const result = await init({ cwd, git: fakeGit(['devel', 'as/v2.x']) });

  assert.equal(result.written, true);
  assert.match(
    result.text,
    new RegExp(`^# yaml-language-server: \\$schema=${SCHEMA_URL}`),
  );

  // The file we just wrote has to be readable by our own reader.
  const { lines, problems } = parseSupport(result.text);
  assert.deepEqual(problems, []);
  assert.deepEqual(
    lines.map((line) => line.version),
    ['3.x', '2.x'],
  );
  assert.match(
    await readFile(join(cwd, 'SUPPORT.yaml'), 'utf8'),
    /version: "3\.x"/,
  );
});

test('init refuses to overwrite a file without --force', async () => {
  const cwd = await makeTempDir({
    'SUPPORT.yaml': 'lines:\n  - version: "9.x"\n    stage: indev\n',
  });

  const result = await init({ cwd, git: fakeGit(['devel']) });

  assert.equal(result.written, false);
  assert.equal(result.exitCode, 1);
  assert.match(result.problems[0].message, /already exists/);
  // The old file is untouched.
  assert.match(await readFile(join(cwd, 'SUPPORT.yaml'), 'utf8'), /"9\.x"/);
});

test('--force writes over the old file', async () => {
  const cwd = await makeTempDir({
    'SUPPORT.yaml': 'lines:\n  - version: "9.x"\n    stage: indev\n',
  });

  const result = await init({ cwd, git: fakeGit(['devel']), force: true });

  assert.equal(result.written, true);
  assert.match(await readFile(join(cwd, 'SUPPORT.yaml'), 'utf8'), /"1\.x"/);
});

test('createSupport refuses an existing file, writeSupport replaces it', async () => {
  const cwd = await makeTempDir({ 'SUPPORT.yaml': 'old\n' });

  // The exclusive create is what keeps a non-forced init honest.
  await assert.rejects(
    () => createSupport(cwd, 'new\n'),
    (thrown) => thrown.code === 'EEXIST',
  );
  assert.equal(await readFile(join(cwd, 'SUPPORT.yaml'), 'utf8'), 'old\n');

  // The replace path writes through a temporary file and renames it, so no
  // temporary file is left lying around afterwards.
  await writeSupport(cwd, 'new\n');
  assert.equal(await readFile(join(cwd, 'SUPPORT.yaml'), 'utf8'), 'new\n');
  assert.deepEqual(await readdir(cwd), ['SUPPORT.yaml']);
});

test('a SUPPORT.yaml that appears mid-run is refused, not clobbered', async () => {
  const cwd = await makeTempDir();
  const racingGit = {
    ...fakeGit(['devel']),
    // Somebody writes the file while we are guessing lines from branches.
    branches: async () => {
      await writeFile(
        join(cwd, 'SUPPORT.yaml'),
        'lines:\n  - version: "9.x"\n    stage: indev\n',
        'utf8',
      );
      return ['devel'];
    },
  };

  const result = await init({ cwd, git: racingGit });

  assert.equal(result.written, false);
  assert.equal(result.exitCode, 1);
  assert.match(result.problems[0].message, /already exists/);
  assert.match(await readFile(join(cwd, 'SUPPORT.yaml'), 'utf8'), /"9\.x"/);
});

test('a git failure writes nothing', async () => {
  const cwd = await makeTempDir();
  const brokenGit = {
    ...fakeGit([]),
    branches: async () => {
      throw new Error('not a git repository');
    },
  };

  const result = await init({ cwd, git: brokenGit });

  assert.equal(result.written, false);
  assert.equal(result.exitCode, 1);
  assert.match(result.problems[0].message, /Could not read the repository/);
  await assert.rejects(() => readFile(join(cwd, 'SUPPORT.yaml'), 'utf8'));
});

test('init writes nothing while another command holds the lock', async () => {
  const cwd = await makeTempDir();
  const lock = holdSupportLock(cwd);
  await lock.acquired;

  const result = await init({ cwd, git: fakeGit(['devel']) });

  // init writes the whole file like every other writer, so it must take the
  // lock too: without it, this could overwrite a line another command had just
  // moved.
  assert.equal(result.written, false);
  assert.equal(result.exitCode, 1);
  assert.match(result.problems[0].message, /Another Lifeline command/);
  await assert.rejects(() => readFile(join(cwd, 'SUPPORT.yaml'), 'utf8'));

  lock.release();
  await lock.finished;

  assert.equal((await init({ cwd, git: fakeGit(['devel']) })).written, true);
});

// Integration tests below: real repositories and the real git wrapper.

test('integration: init then check passes on a real repository', async () => {
  const { cwd } = await makeGitRepo({
    branches: ['as/v2.x', 'ls/v1.x'],
    tags: ['v1.x-eol'],
  });

  const written = await init({ cwd, git: createGit({ cwd }) });
  assert.equal(written.written, true);

  const result = await check({ cwd, git: createGit({ cwd }), now: new Date() });
  // The only thing left to decide by hand is the eol date of the ls line.
  assert.deepEqual(
    result.problems.filter((problem) => problem.level === 'error'),
    [],
  );
});

test('integration: a repository with only devel gets one 1.x line', async () => {
  const { cwd } = await makeGitRepo();

  const result = await init({ cwd, git: createGit({ cwd }) });

  assert.deepEqual(result.lines, [{ version: '1.x', stage: 'indev' }]);
  assert.equal(result.exitCode, 0);
});

test('integration: branches on the remote are found too', async () => {
  const { cwd } = await makeGitRepo({
    branches: ['as/v2.x'],
    withRemote: true,
  });
  // Delete the local branch: only origin/as/v2.x is left.
  await git(['branch', '-D', 'as/v2.x'], cwd);

  const result = await init({ cwd, git: createGit({ cwd }) });

  assert.deepEqual(result.lines, [
    { version: '3.x', stage: 'indev' },
    { version: '2.x', stage: 'as' },
  ]);
});
