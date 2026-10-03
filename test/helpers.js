// Helpers for tests. Shared setup, so each test file stays about one thing.

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { withSupportLock } from '../src/support-file.js';

const execFileAsync = promisify(execFile);

/**
 * Create a throwaway directory, optionally filling it with files.
 * @param {Record<string, string>} [files] File name -> contents.
 * @returns {Promise<string>} The directory path.
 */
export async function makeTempDir(files = {}) {
  // mkdtemp makes a unique directory inside the system temp folder.
  const dir = await mkdtemp(join(tmpdir(), 'lifeline-test-'));
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, 'utf8');
  }
  return dir;
}

/** A SUPPORT.yaml body with sensible defaults, for tests that need one. */
export function supportYaml(lines = [{ version: '2.x', stage: 'as' }]) {
  const body = lines
    .map((line) => {
      // A list entry starts with "- " and every following key has to line up
      // under the first one, four spaces in.
      const fields = [`version: "${line.version}"`, `stage: ${line.stage}`];
      if (line.eol) {
        fields.push(`eol: ${line.eol}`);
      }
      return `  - ${fields.join('\n    ')}`;
    })
    .join('\n');
  return `lines:\n${body}\n`;
}

/**
 * Run git in a directory and return what it printed. Tests use the real git
 * binary, so they exercise the same commands the CLI does.
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<string>}
 */
export async function git(args, cwd) {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

/**
 * Write files, stage them, and commit them. Tests that need extra commits (for
 * example a commit to backport) call this after makeGitRepo().
 * @param {string} cwd
 * @param {Record<string, string>} files File name -> contents.
 * @param {string} message Commit message.
 * @returns {Promise<string>} The new commit's short sha.
 */
export async function commitFiles(cwd, files, message) {
  for (const [name, content] of Object.entries(files)) {
    const path = join(cwd, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, 'utf8');
  }
  await git(['add', '--all'], cwd);
  await git(['commit', '-m', message], cwd);
  return (await git(['rev-parse', '--short', 'HEAD'], cwd)).trim();
}

/**
 * Build a throwaway git repository with a `devel` branch, one commit, and
 * whatever branches, tags and support file the test asks for.
 *
 * @param {object} [options]
 * @param {string[]} [options.branches] Branches to create, off devel.
 * @param {string[]} [options.tags] Tags to create.
 * @param {string} [options.support] Contents of SUPPORT.yaml.
 * @param {boolean} [options.withRemote] Add a bare "origin" and push to it, so
 *   the repository has real remote-tracking branches.
 * @param {Record<string, Record<string, string>>} [options.branchFiles] Files to
 *   commit on a branch, keyed by branch name. A file that also changes on devel
 *   is what makes a backport conflict.
 * @returns {Promise<{cwd: string, remote: string | null}>}
 */
export async function makeGitRepo({
  branches = [],
  tags = [],
  support,
  withRemote = false,
  branchFiles = {},
} = {}) {
  const cwd = await makeTempDir(support ? { 'SUPPORT.yaml': support } : {});

  await git(['init', '-b', 'devel'], cwd);
  // Configure the identity inside this repository only, never on the machine.
  await git(['config', 'user.name', 'Lifeline Test'], cwd);
  await git(['config', 'user.email', 'test@example.com'], cwd);

  // Commit README.md and, when the test asked for one, SUPPORT.yaml. Both are
  // committed, so every branch starts from the same clean tree.
  await writeFile(join(cwd, 'README.md'), '# test repository\n');
  await git(['add', '--all'], cwd);
  await git(['commit', '-m', 'first commit'], cwd);

  for (const name of branches) {
    await git(['branch', name], cwd);
  }
  for (const name of tags) {
    await git(['tag', name], cwd);
  }

  // Give branches their own content, so they differ from devel.
  for (const [name, files] of Object.entries(branchFiles)) {
    await git(['checkout', name], cwd);
    await commitFiles(cwd, files, `content on ${name}`);
    await git(['checkout', 'devel'], cwd);
  }

  let remote = null;
  if (withRemote) {
    // A bare repository in its own temporary directory plays the part of the
    // server, so parallel runs never share one.
    const server = await makeTempDir();
    remote = join(server, 'remote.git');
    await git(['init', '--bare', '-b', 'devel', remote], cwd);
    await git(['remote', 'add', 'origin', remote], cwd);
    await git(['push', '-u', 'origin', 'devel'], cwd);
    if (branches.length > 0) {
      await git(['push', 'origin', ...branches], cwd);
    }
  }

  return { cwd, remote };
}

/**
 * Take the support lock for a directory and hold it until released.
 *
 * Tests that need a second Lifeline command to find the file locked start one
 * of these, wait for `acquired`, and call `release` when they are done.
 *
 * @param {string} cwd
 * @returns {{acquired: Promise<void>, release: () => void, finished: Promise<object>}}
 */
export function holdSupportLock(cwd) {
  let acquired;
  let acquisitionFailed;
  const gotIt = new Promise((resolve, reject) => {
    acquired = resolve;
    acquisitionFailed = reject;
  });
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  return {
    acquired: gotIt,
    release: () => release(),
    finished: withSupportLock(cwd, async () => {
      acquired();
      await held;
    }).then((result) => {
      if (!result.ok) {
        acquisitionFailed(result.problem);
      }
      return result;
    }),
  };
}

/**
 * A forge that records what it was asked for instead of calling GitHub. Tests
 * use this so nothing reaches the network.
 * @param {{prUrl?: string, failPreflight?: string, failCreate?: string}} [options]
 * @returns {import('../src/forge/github.js').Forge & {calls: object[], preflightCalls: number}}
 */
export function makeFakeForge({
  prUrl = 'https://github.test/org/repo/pull/7',
  failPreflight = null,
  failCreate = null,
} = {}) {
  const calls = [];
  let preflightCalls = 0;

  return {
    calls,
    get preflightCalls() {
      return preflightCalls;
    },
    async preflight() {
      preflightCalls += 1;
      if (failPreflight) {
        throw new Error(failPreflight);
      }
    },
    async createPullRequest(request) {
      calls.push(request);
      if (failCreate) {
        throw new Error(failCreate);
      }
      return { url: prUrl };
    },
  };
}
