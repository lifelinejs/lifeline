// Tests for src/git/git.js. These run the real git binary against throwaway
// repositories built by test/helpers.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createGit, isClean, listBranches, listTags } from '../src/git/git.js';
import { git, makeGitRepo, makeTempDir } from './helpers.js';

test('listBranches returns local branches', async () => {
  const { cwd } = await makeGitRepo({ branches: ['as/v2.x', 'ls/v1.x'] });

  assert.deepEqual(await listBranches({ cwd }), [
    'as/v2.x',
    'devel',
    'ls/v1.x',
  ]);
});

test('listBranches strips the remote prefix and drops HEAD', async () => {
  const { cwd } = await makeGitRepo({
    branches: ['as/v2.x'],
    withRemote: true,
  });

  const branches = await listBranches({ cwd });

  // "origin/as/v2.x" and "origin/devel" are the same branches as the local
  // ones, so they must not appear twice.
  assert.deepEqual(branches, ['as/v2.x', 'devel']);
  assert.ok(!branches.includes('HEAD'));
});

test('branches of another remote keep their prefix', async () => {
  const { cwd } = await makeGitRepo({ withRemote: true });
  const server = await makeTempDir();
  const upstream = join(server, 'upstream.git');

  await git(['init', '--bare', '-b', 'devel', upstream], cwd);
  await git(['remote', 'add', 'upstream', upstream], cwd);
  await git(['push', 'upstream', 'HEAD:refs/heads/only-upstream'], cwd);

  // We only know how to strip the remote we were told about.
  const branches = await listBranches({ cwd, remote: 'origin' });

  assert.ok(branches.includes('upstream/only-upstream'));
  assert.ok(!branches.includes('only-upstream'));
});

test('listTags returns tag names', async () => {
  const { cwd } = await makeGitRepo({ tags: ['v0.x-eol', 'v1.0.0'] });

  assert.deepEqual(await listTags({ cwd }), ['v0.x-eol', 'v1.0.0']);
});

test('listTags on a repo without tags is an empty list', async () => {
  const { cwd } = await makeGitRepo();

  assert.deepEqual(await listTags({ cwd }), []);
});

test('isClean is false when a file changes', async () => {
  const { cwd } = await makeGitRepo();

  assert.equal(await isClean({ cwd }), true);
  await writeFile(join(cwd, 'README.md'), 'changed\n');
  assert.equal(await isClean({ cwd }), false);
});

test('createGit binds every command to one directory', async () => {
  const { cwd } = await makeGitRepo({
    branches: ['as/v2.x'],
    tags: ['v0.x-eol'],
  });
  const git = createGit({ cwd, remote: 'origin' });

  assert.deepEqual(await git.branches(), ['as/v2.x', 'devel']);
  assert.deepEqual(await git.tags(), ['v0.x-eol']);
  assert.equal(await git.isClean(), true);
  assert.match(await git.run(['rev-parse', '--abbrev-ref', 'HEAD']), /devel/);
});

test('a directory that is not a repository makes git fail loudly', async () => {
  const { cwd } = await makeGitRepo();
  const notARepo = join(cwd, 'subdir');

  await assert.rejects(() => listBranches({ cwd: notARepo }));
});
