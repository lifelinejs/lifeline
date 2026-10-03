// The GitHub forge: opening pull requests through the `gh` command line tool.
//
// This is the ONLY file in Lifeline that knows `gh` exists. Everything else
// talks to a `forge` object with a `createPullRequest()` method, so GitHub can
// be swapped for Octokit later without touching the commands.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * The interface a forge has to provide. A test can pass a fake instead.
 *
 * @typedef {Object} Forge
 * @property {() => Promise<void>} preflight Check that we can open a pull
 *   request at all, before anything is changed locally.
 * @property {(request: {base: string, head: string, title: string, body: string,
 *   labels: string[]}) => Promise<{url: string}>} createPullRequest
 */

/** What to tell the user when `gh` is not there. */
const MISSING_GH =
  'backport needs the GitHub CLI; install it and run `gh auth login`';

/** What to tell the user when `gh` is there but has no login. */
const NOT_LOGGED_IN =
  'backport needs the GitHub CLI; run `gh auth login` to sign in';

/**
 * Make sure `gh` is installed and signed in. Called before the backport branch
 * is created, so a missing tool cannot leave a branch behind.
 *
 * @param {{cwd?: string}} [options]
 * @returns {Promise<void>} Rejects with an Error carrying a readable message.
 */
export async function preflight({ cwd } = {}) {
  try {
    await execFileAsync('gh', ['--version'], { cwd });
  } catch {
    // execFile rejects with ENOENT when the program does not exist at all.
    throw new Error(MISSING_GH);
  }

  try {
    // gh exits non-zero when it is not logged in, and prints why on stderr.
    await execFileAsync('gh', ['auth', 'status'], { cwd });
  } catch {
    throw new Error(NOT_LOGGED_IN);
  }
}

/**
 * Turn a remote URL into gh's [HOST/]OWNER/REPO form.
 *
 * Understands the shapes git accepts for a GitHub remote: https, ssh, git://
 * and the scp-like `git@host:owner/repo`. Exported for the tests.
 * Preflight checks the host's GitHub API, including Enterprise hosts.
 *
 * @param {string} url What `git remote get-url` printed.
 * @param {string} [remote] The remote's name; only used in the error message.
 * @returns {string} For example "github.com/org/repo".
 * @throws {Error} When the URL is not a repository URL gh could use.
 */
export function parseRepositoryUrl(url, remote = 'origin') {
  const trimmed = url.trim();
  let host;
  let path;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    // A scheme URL: https://github.com/org/repo, ssh://git@github.com/org/repo.
    try {
      const parsed = new URL(trimmed);
      if (
        ['https:', 'ssh:', 'git:'].includes(parsed.protocol) &&
        !parsed.search &&
        !parsed.hash
      ) {
        host = parsed.hostname;
        path = parsed.pathname;
      }
    } catch {
      // Malformed URL; fall through to the error below.
    }
  } else {
    // The scp-like syntax git also allows: git@github.com:org/repo.
    const scp = trimmed.match(/^(?:[^@]+@)?([^:/]+):(.+)$/);
    if (scp) {
      host = scp[1];
      path = scp[2];
    }
  }

  path = path?.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
  if (
    /^[a-z0-9.-]+$/i.test(host ?? '') &&
    /^[a-z0-9_-]+\/[a-z0-9_.-]+$/i.test(path ?? '') &&
    !['.', '..'].includes(path.split('/')[1])
  ) {
    return `${host.toLowerCase()}/${path}`;
  }

  throw new Error(
    `remote "${remote}" points at ${JSON.stringify(url.trim())}, which is not ` +
      'a repository URL; pull requests need an https or ssh GitHub remote.',
  );
}

/**
 * The repository a git remote points at, in the form gh wants it.
 *
 * The pull request is created for the remote the backport was validated and
 * pushed to, never for whatever repository gh would guess from the checkout:
 * in a checkout with several remotes, those can be different repositories.
 *
 * @param {{cwd?: string, remote?: string}} options
 * @returns {Promise<string>} For example "github.com/org/repo".
 * @throws {Error} When the remote is missing or cannot be read as a GitHub URL.
 */
export async function repositoryForRemote({ cwd, remote = 'origin' } = {}) {
  let url;
  let pushUrls;
  try {
    ({ stdout: url } = await execFileAsync(
      'git',
      ['remote', 'get-url', remote],
      { cwd },
    ));
    ({ stdout: pushUrls } = await execFileAsync(
      'git',
      ['remote', 'get-url', '--push', '--all', remote],
      { cwd },
    ));
  } catch {
    throw new Error(
      `remote "${remote}" is not configured; a pull request needs a GitHub remote.`,
    );
  }
  const repo = parseRepositoryUrl(url, remote);
  for (const pushUrl of pushUrls.trim().split('\n')) {
    const pushRepo = parseRepositoryUrl(pushUrl, remote);
    if (pushRepo.toLowerCase() !== repo.toLowerCase()) {
      throw new Error(
        `remote "${remote}" has different fetch and push repositories; ` +
          'use a remote that fetches from and pushes to the same GitHub repository.',
      );
    }
  }
  return repo;
}

/**
 * Open a pull request.
 *
 * @param {object} request
 * @param {string} request.base Branch to merge into, e.g. "ls/v1.x".
 * @param {string} request.head Branch holding the backport.
 * @param {string} request.title
 * @param {string} request.body
 * @param {string[]} [request.labels]
 * @param {string} [request.cwd] Repository to work in.
 * @param {string | null} [request.repo] Repository in HOST/OWNER/REPO form to
 *   create the pull request in. Omitted only when the caller has no remote to
 *   name, which gh's own guess is not good enough to fall back on silently.
 * @returns {Promise<{url: string}>} Where the pull request ended up.
 */
export async function createPullRequest({
  base,
  head,
  title,
  body,
  labels = [],
  cwd,
  repo = null,
}) {
  // Every argument is one array entry, so nothing in a title can be read as a
  // shell command. No shell is started at all.
  const args = ['pr', 'create'];
  // Name the repository outright: without --repo, gh picks one from the
  // checkout, which need not be the remote this backport was pushed to.
  if (repo) {
    args.push('--repo', repo);
  }
  args.push('--base', base, '--head', head, '--title', title, '--body', body);
  for (const label of labels) {
    args.push('--label', label);
  }

  let output;
  try {
    ({ stdout: output } = await execFileAsync('gh', args, { cwd }));
  } catch (ghError) {
    // gh puts the interesting part on stderr; show it instead of our wrapper.
    const detail = String(ghError.stderr || '').trim() || ghError.message;
    throw new Error(`gh pr create failed: ${detail}`);
  }

  // gh prints the new pull request's URL on the last line of its output.
  const lines = String(output).trim().split('\n');
  return { url: lines[lines.length - 1].trim() };
}

/**
 * Build the forge object commands receive.
 *
 * Everything it does is bound to `remote`: the repository it names for a
 * pull request is the one that remote points at, so a checkout with several
 * remotes cannot send a backport to the wrong repository.
 *
 * @param {{cwd?: string, remote?: string}} options
 * @returns {Forge}
 */
export function createGithubForge({ cwd, remote = 'origin' } = {}) {
  return {
    preflight: async () => {
      await preflight({ cwd });
      // Settle which repository the pull request would go to as well, before
      // any branch is made: a remote we cannot name must stop the backport
      // here, not halfway through.
      const repo = await repositoryForRemote({ cwd, remote });
      try {
        // A GitHub-shaped URL is not proof that the host runs GitHub or that
        // this login can access the repository. Ask its API before pushing.
        await execFileAsync('gh', ['repo', 'view', repo, '--json', 'id'], {
          cwd,
        });
      } catch {
        throw new Error(
          `remote "${remote}" must point to an accessible GitHub repository; ` +
            `check ${repo} and your GitHub CLI login for its host.`,
        );
      }
    },
    createPullRequest: async (request) => {
      const repo = await repositoryForRemote({ cwd, remote });
      return createPullRequest({ ...request, cwd, repo });
    },
  };
}
