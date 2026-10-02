// Tests for src/git/git.js. These run the real git binary against throwaway
// repositories built by test/helpers.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  branchExists,
  createGit,
  isAncestor,
  isClean,
  listBranches,
  listTags,
  readCommit,
} from '../src/git/git.js';
import { commitFiles, git, makeGitRepo, makeTempDir } from './helpers.js';

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

test('branchExists knows about short names like origin/devel', async () => {
  const { cwd } = await makeGitRepo({ withRemote: true });

  // show-ref would need the full name here; rev-parse does not.
  assert.equal(await branchExists({ cwd, ref: 'devel' }), true);
  assert.equal(await branchExists({ cwd, ref: 'origin/devel' }), true);
  assert.equal(await branchExists({ cwd, ref: 'as/v1.x' }), false);
  assert.equal(await branchExists({ cwd, ref: 'origin/nope' }), false);
});

test('isAncestor asks whether one commit is already in another', async () => {
  const { cwd } = await makeGitRepo();
  const first = (await git(['rev-parse', 'HEAD'], cwd)).trim();
  const second = await commitFiles(cwd, { 'a.txt': 'a\n' }, 'second');

  assert.equal(await isAncestor({ cwd, sha: first, ref: second }), true);
  assert.equal(await isAncestor({ cwd, sha: second, ref: first }), false);

  // A name git cannot make sense of is "no", not a crash.
  assert.equal(await isAncestor({ cwd, sha: second, ref: 'nope' }), false);
});

test('readCommit reads what a backport needs about a commit', async () => {
  const { cwd } = await makeGitRepo();
  const shortSha = await commitFiles(cwd, { 'a.txt': 'a\n' }, 'fix: a thing');

  const commit = await readCommit({ cwd, ref: shortSha });

  assert.match(commit.sha, /^[0-9a-f]{40}$/);
  assert.equal(commit.shortSha, shortSha);
  assert.equal(commit.subject, 'fix: a thing');
  assert.equal(commit.parents.length, 1);
});

test('readCommit lists two parents for a merge commit', async () => {
  const { cwd } = await makeGitRepo();
  await git(['checkout', '-b', 'side'], cwd);
  await commitFiles(cwd, { 'side.txt': 'side\n' }, 'side work');
  await git(['checkout', 'devel'], cwd);
  await commitFiles(cwd, { 'main.txt': 'main\n' }, 'main work');
  await git(['merge', '--no-ff', '-m', 'Merge side', 'side'], cwd);

  const commit = await readCommit({ cwd, ref: 'HEAD' });

  assert.equal(commit.parents.length, 2);
});

test('readCommit resolves short names and rejects unknown ones', async () => {
  const { cwd } = await makeGitRepo();
  const sha = (await git(['rev-parse', '--short', 'HEAD'], cwd)).trim();

  const commit = await readCommit({ cwd, ref: 'devel' });
  assert.equal(commit.shortSha, sha);

  await assert.rejects(() => readCommit({ cwd, ref: 'not-a-commit' }));
});
