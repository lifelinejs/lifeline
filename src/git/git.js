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
 * @property {(name: string) => Promise<boolean>} fetchTag Fetch one tag by
 *   name; false when the remote does not have it.
 * @property {(ref: string) => Promise<boolean>} branchExists Is there a ref?
 * @property {(sha: string, ref: string) => Promise<boolean>} isAncestor
 *   Is `sha` reachable from `ref`?
 * @property {(ref: string) => Promise<Commit>} commit Read a commit.
 * @property {(args: string[]) => Promise<string>} run Any other git command.
 */

/**
 * @typedef {Object} Commit
 * @property {string} sha The full commit hash.
 * @property {string} shortSha The short form, as git prints it.
 * @property {string} subject The first line of the commit message.
 * @property {string[]} parents Parent hashes; a root commit has none.
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
    env: { ...process.env, LC_ALL: 'C' },
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
    fetchTag: (name) => fetchTag({ cwd, remote, name }),
    branchExists: (ref) => branchExists({ cwd, ref }),
    isAncestor: (sha, ref) => isAncestor({ cwd, sha, ref }),
    commit: (ref) => readCommit({ cwd, ref }),
    run: (args) => git(args, { cwd }),
  };
}

/**
 * Fetch one tag by name.
 *
 * `git fetch <remote>` only follows tags that point into the history it just
 * fetched, so a tag that is really on the remote can still be missing here: a
 * repository configured with `tagOpt = --no-tags`, or a tag made since the last
 * time the commit it points at was fetched. Asking for the tag by name is the
 * only way to be sure it has arrived.
 *
 * A tag the remote does not have is `false`, not a failure: `check` reports
 * that as a finding of its own. Any other complaint is a real failure and is
 * thrown, so that a network problem is never read as "there is no tag".
 *
 * @param {{cwd: string, remote?: string, name: string}} options
 * @returns {Promise<boolean>} Whether the tag was fetched.
 * @throws {Error} When the fetch failed for any reason other than the tag being
 *   absent from the remote.
 */
export async function fetchTag({ cwd, remote = 'origin', name }) {
  try {
    await git(['fetch', remote, 'tag', name], { cwd });
    return true;
  } catch (fetchError) {
    // What git says when the ref it was asked for is not there.
    if (String(fetchError.stderr || '').includes("couldn't find remote ref")) {
      return false;
    }
    throw fetchError;
  }
}

/**
 * Is there a branch or ref with this name, and does it point at a commit?
 *
 * `rev-parse` is used rather than `show-ref` because it understands short names
 * like `origin/devel`. `--quiet` keeps git quiet when the name is unknown, and
 * `^{commit}` fails for names that are not commits (a directory, say).
 *
 * @param {{cwd: string, ref: string}} options
 * @returns {Promise<boolean>}
 */
export async function branchExists({ cwd, ref }) {
  try {
    await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd });
    return true;
  } catch {
    return false;
  }
}

/**
 * Can we reach `sha` from `ref`? Used to check that a commit is already on
 * the development branch.
 * @param {{cwd: string, sha: string, ref: string}} options
 * @returns {Promise<boolean>}
 */
export async function isAncestor({ cwd, sha, ref }) {
  try {
    await git(['merge-base', '--is-ancestor', sha, ref], { cwd });
    return true;
  } catch {
    // git exits with 1 when the commit is not an ancestor, and with 128 when
    // it cannot make sense of the arguments. Both mean "no", and the caller
    // has already checked that both names exist.
    return false;
  }
}

/**
 * Read what we need to know about a commit. Fails if the name is not a commit.
 * @param {{cwd: string, ref: string}} options `ref` may be any git name.
 * @returns {Promise<Commit>}
 */
export async function readCommit({ cwd, ref }) {
  // "^{commit}" means "the commit this name points at"; it fails loudly when
  // the name is unknown.
  const sha = (
    await git(['rev-parse', '--verify', `${ref}^{commit}`], { cwd })
  ).trim();
  const shortSha = (await git(['rev-parse', '--short', sha], { cwd })).trim();
  const subject = (
    await git(['show', '-s', '--format=%s', sha], { cwd })
  ).trim();
  const parents = (
    await git(['show', '-s', '--format=%P', sha], { cwd })
  ).trim();

  return {
    sha,
    shortSha,
    subject,
    parents: parents === '' ? [] : parents.split(' '),
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
