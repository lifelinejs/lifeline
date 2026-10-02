// Thin wrappers around the git command line.
//
// Every call goes through execFile with an *array* of arguments and no shell,
// so a branch name can never be read as a shell command. The functions return
// plain data (arrays of strings, booleans), never raw git output.
//
// Commands take a ready-made `git` object (see createGit) as an argument, so
// tests can hand them a fake instead of running git at all.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// execFile is callback-based; promisify turns it into something we can await.
const execFileAsync = promisify(execFile);

/** A branch list of a big monorepo still fits well inside this. */
const MAX_BUFFER = 10 * 1024 * 1024;

/**
 * @typedef {Object} Git
 * @property {() => Promise<string[]>} branches Local and remote-tracking
 *   branch names, without their `<remote>/` prefix.
 * @property {() => Promise<string[]>} tags Tag names.
 * @property {() => Promise<boolean>} isClean Is the working tree clean?
 * @property {() => Promise<void>} fetchRemote Run `git fetch <remote>`.
 * @property {(args: string[]) => Promise<string>} run Any other git command.
 */

/**
 * Run git and return what it printed.
 * @param {string[]} args Arguments for git, one array entry each.
 * @param {{cwd: string}} options
 * @returns {Promise<string>}
 */
async function git(args, options) {
  const { stdout } = await execFileAsync('git', args, {
    cwd: options.cwd,
    maxBuffer: MAX_BUFFER,
  });
  return stdout;
}

/**
 * Every branch Lifeline knows about, local and remote-tracking.
 *
 * `origin/devel` becomes `devel`, and the `origin/HEAD` symref is dropped:
 * it is not a branch anyone can work on.
 *
 * @param {{cwd: string, remote?: string}} options
 * @returns {Promise<string[]>} Names without duplicates.
 */
export async function listBranches({ cwd, remote = 'origin' }) {
  const output = await git(
    ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'],
    { cwd },
  );

  // A Set removes duplicates: local "as/v2.x" and remote "origin/as/v2.x" are
  // the same branch as far as Lifeline is concerned.
  const names = new Set();
  for (const raw of output.split('\n')) {
    const name = stripRemotePrefix(raw.trim(), remote);
    if (name && name !== 'HEAD') {
      names.add(name);
    }
  }
  return [...names].sort();
}

/**
 * Every tag name, for example "v0.x-eol".
 * @param {{cwd: string}} options
 * @returns {Promise<string[]>}
 */
export async function listTags({ cwd }) {
  const output = await git(['tag', '--list'], { cwd });
  return output
    .split('\n')
    .map((name) => name.trim())
    .filter(Boolean);
}

/**
 * Is the working tree free of staged and unstaged changes?
 * `--porcelain` gives one short line per change, so no output means clean.
 * @param {{cwd: string}} options
 * @returns {Promise<boolean>}
 */
export async function isClean({ cwd }) {
  const output = await git(['status', '--porcelain'], { cwd });
  return output.trim() === '';
}

/**
 * Bring remote-tracking refs up to date. Needs the network, so `check` only
 * does this when it is asked to.
 * @param {{cwd: string, remote?: string}} options
 * @returns {Promise<void>}
 */
export async function fetchRemote({ cwd, remote = 'origin' }) {
  await git(['fetch', remote], { cwd });
}

/**
 * Build the git object a command needs. Every function is bound to the
 * directory and remote, so commands do not have to repeat them.
 * @param {{cwd: string, remote?: string}} options
 * @returns {Git}
 */
export function createGit({ cwd, remote = 'origin' }) {
  return {
    branches: () => listBranches({ cwd, remote }),
    tags: () => listTags({ cwd }),
    isClean: () => isClean({ cwd }),
    fetchRemote: () => fetchRemote({ cwd, remote }),
    run: (args) => git(args, { cwd }),
  };
}

/**
 * "origin/as/v2.x" -> "as/v2.x". Other remotes are left alone.
 * @param {string} name
 * @param {string} remote
 * @returns {string}
 */
function stripRemotePrefix(name, remote) {
  const prefix = `${remote}/`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}
