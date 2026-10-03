// Tests for `lifeline init`: guessing lines from branches, writing the file,
// and refusing to clobber an existing one.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { check } from '../src/commands/check.js';
import { init, starterLines } from '../src/commands/init.js';
import { linesFromBranches } from '../src/core/discover.js';
import { createGit } from '../src/git/git.js';
import {
  COULD_NOT_READ,
  createSupport,
  SCHEMA_URL,
  SUPPORT_CHANGED,
  SUPPORT_FILE,
  writeSupport,
} from '../src/support-file.js';
import { parseSupport } from '../src/core/support.js';
import { BODY_SIZE } from './fixtures/interrupted-write.js';
import {
  git,
  holdSupportLock,
  makeGitRepo,
  makeTempDir,
  supportYaml,
} from './helpers.js';

// execFile runs a program without a shell, so nothing in it can be interpreted.
const execFileAsync = promisify(execFile);

/** The script that writes SUPPORT.yaml under a hard file size limit. */
const INTERRUPTED_WRITE = fileURLToPath(
  new URL('./fixtures/interrupted-write.js', import.meta.url),
);

/** How many 512-byte blocks that write may produce before it is cut off. */
const FILE_SIZE_BLOCKS = 8;

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

/** The lines SUPPORT.yaml holds right now, without the absent keys. */
async function linesIn(cwd) {
  const parsed = parseSupport(
    await readFile(join(cwd, 'SUPPORT.yaml'), 'utf8'),
  );
  assert.deepEqual(parsed.problems, []);
  return parsed.lines.map((line) => ({
    version: line.version,
    stage: line.stage,
  }));
}

/**
 * Write SUPPORT.yaml in a process of its own, with a hard limit on how large a
 * file it may write, so that the write is cut off part way through on purpose.
 *
 * That limit is what the kernel enforces on the size of a file, which is the
 * same thing that stops a write on a full disk. It has to be a process of its
 * own because the limit belongs to a process.
 *
 * @param {string[]} args Arguments for the fixture.
 * @returns {Promise<{written: boolean, code: string | null}>} What the fixture
 *   says happened, so a test cannot pass on a write that was never in trouble.
 */
async function writeUnderSizeLimit(args) {
  // The shell applies the limit and then hands over to the fixture, so the limit
  // is the only thing between the two. `$0` is the shell's own name, so the
  // limit is `$1` and the command is everything after it.
  const { stdout } = await execFileAsync('/bin/sh', [
    '-c',
    'ulimit -f "$1"; shift; exec "$@"',
    'lifeline-test',
    String(FILE_SIZE_BLOCKS),
    process.execPath,
    INTERRUPTED_WRITE,
    ...args,
  ]);
  return JSON.parse(stdout);
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

test('--force does not overwrite a file saved while it was running', async () => {
  const cwd = await makeTempDir({
    'SUPPORT.yaml': 'lines:\n  - version: "9.x"\n    stage: indev\n',
  });
  const saved = 'lines:\n  - version: "9.x"\n    stage: as\n';
  const editingGit = {
    ...fakeGit(['devel']),
    // An editor saves while init is reading the branches. Nothing takes the
    // support lock for a save from an editor, and --force is not a licence to
    // throw that save away.
    branches: async () => {
      await writeFile(join(cwd, 'SUPPORT.yaml'), saved, 'utf8');
      return ['devel'];
    },
  };

  const result = await init({ cwd, git: editingGit, force: true });

  assert.equal(result.written, false);
  assert.equal(result.exitCode, 1);
  assert.match(result.problems[0].message, /changed while this command was/);
  assert.match(result.problems[0].message, /nothing was written/);
  // Their save is still the file.
  assert.equal(await readFile(join(cwd, 'SUPPORT.yaml'), 'utf8'), saved);
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
  // temporary file is left lying around afterwards. A writer says what it read,
  // which is what the replace is checked against.
  await writeSupport(cwd, 'new\n', 'old\n');
  assert.equal(await readFile(join(cwd, 'SUPPORT.yaml'), 'utf8'), 'new\n');
  assert.deepEqual(await readdir(cwd), ['SUPPORT.yaml']);
});

test('writeSupport refuses a file that has moved on since it was read', async () => {
  const cwd = await makeTempDir({ 'SUPPORT.yaml': 'old\n' });
  const theirs = 'lines:\n  - version: "9.x"\n    stage: indev\n';
  // Somebody who does not take the support lock: an editor, another tool,
  // another copy of Lifeline.
  await writeFile(join(cwd, 'SUPPORT.yaml'), theirs, 'utf8');

  await assert.rejects(
    () => writeSupport(cwd, 'new\n', 'old\n'),
    (thrown) => thrown.code === SUPPORT_CHANGED,
  );

  // Their change is still the file, and nothing was left behind trying.
  assert.equal(await readFile(join(cwd, 'SUPPORT.yaml'), 'utf8'), theirs);
  assert.deepEqual(await readdir(cwd), ['SUPPORT.yaml']);
});

test('writeSupport refuses a file that appeared where there was none', async () => {
  const cwd = await makeTempDir();

  await writeSupport(cwd, 'new\n', null);
  assert.equal(await readFile(join(cwd, 'SUPPORT.yaml'), 'utf8'), 'new\n');

  // And the same writer, told there was no file, does not replace one that is
  // there now.
  await assert.rejects(
    () => writeSupport(cwd, 'newer\n', null),
    (thrown) => thrown.code === SUPPORT_CHANGED,
  );
  assert.equal(await readFile(join(cwd, 'SUPPORT.yaml'), 'utf8'), 'new\n');
});

test('writeSupport replaces a file that still cannot be read', async (t) => {
  const cwd = await makeTempDir();

  // A file this process cannot read, whatever its rights are: a symbolic link
  // that points at itself never resolves. `chmod` would not do, since a mode of
  // zero is advice rather than a rule for root, and on Windows it is not even
  // read that way. Where a file system cannot make the link at all, there is
  // nothing here to test.
  let linked = false;
  try {
    await symlink(SUPPORT_FILE, join(cwd, SUPPORT_FILE), 'file');
    linked = true;
  } catch (linkError) {
    t.skip(
      `this file system cannot make a self-referencing link: ${linkError.code}`,
    );
    return;
  }
  assert.equal(linked, true);

  // The one caller with no text to compare: `init --force` was told to replace
  // this file and could not read it. Its write goes ahead while the file still
  // cannot be read, and replaces the link rather than following it.
  await writeSupport(cwd, 'new\n', COULD_NOT_READ);

  assert.equal(await readFile(join(cwd, SUPPORT_FILE), 'utf8'), 'new\n');
  assert.deepEqual(await readdir(cwd), [SUPPORT_FILE]);
});

test('writeSupport refuses a file that turned out to be readable', async () => {
  const cwd = await makeTempDir({ 'SUPPORT.yaml': 'old\n' });

  // COULD_NOT_READ says the caller could not read the file. If it can be read
  // now, what that caller decided on is out of date, and the write stands down:
  // there is no telling which version of the file it meant to replace.
  await assert.rejects(
    () => writeSupport(cwd, 'new\n', COULD_NOT_READ),
    (thrown) => thrown.code === SUPPORT_CHANGED,
  );

  assert.equal(await readFile(join(cwd, 'SUPPORT.yaml'), 'utf8'), 'old\n');
  assert.deepEqual(await readdir(cwd), ['SUPPORT.yaml']);
});

test('createSupport publishes the file whole and leaves nothing behind', async () => {
  const cwd = await makeTempDir();

  await createSupport(cwd, supportYaml([{ version: '1.x', stage: 'indev' }]));

  // The exclusive create goes through a temporary file too, so a file that is
  // not there yet is never a file that is half there.
  assert.deepEqual(await linesIn(cwd), [{ version: '1.x', stage: 'indev' }]);
  assert.deepEqual(await readdir(cwd), ['SUPPORT.yaml']);
});

// The next two tests cut a write off part way through, which needs a limit the
// kernel enforces, and that means a POSIX shell to set it. Windows has no
// equivalent that can be set from a test, so these do not run there.
const needsPosixShell = {
  skip: process.platform === 'win32' ? 'needs sh' : false,
};

test(
  'a create that is cut off leaves no SUPPORT.yaml at all',
  needsPosixShell,
  async () => {
    const cwd = await makeTempDir();

    const report = await writeUnderSizeLimit([cwd, 'create']);

    // The write really was stopped: without this the test would also pass on a
    // machine where the limit never took effect.
    assert.equal(report.written, false);
    assert.equal(report.code, 'EFBIG');
    // Nothing was published and nothing was left behind. A create that wrote
    // straight into SUPPORT.yaml leaves the first few kilobytes of the file
    // there, which every later command then reads as a broken policy file.
    assert.deepEqual(await readdir(cwd), []);
  },
);

test(
  'a replace that is cut off leaves the old file whole',
  needsPosixShell,
  async () => {
    const before = supportYaml([{ version: '1.x', stage: 'indev' }]);
    const cwd = await makeTempDir({ 'SUPPORT.yaml': before });

    const report = await writeUnderSizeLimit([cwd, 'replace']);

    assert.equal(report.written, false);
    assert.equal(report.code, 'EFBIG');
    // The file that was there before the interrupted write is still there, the
    // whole of it, and the write that failed left no temporary file behind.
    assert.equal(await readFile(join(cwd, 'SUPPORT.yaml'), 'utf8'), before);
    assert.deepEqual(await readdir(cwd), ['SUPPORT.yaml']);
  },
);

test('a whole file that got through is longer than the limit that stopped one', () => {
  // The limit above is a few kilobytes; the fixture's body is much bigger, so a
  // write that was never stopped would have had to be whole to fit through.
  assert.ok(BODY_SIZE > FILE_SIZE_BLOCKS * 512);
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
