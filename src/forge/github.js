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
 * Open a pull request.
 *
 * @param {object} request
 * @param {string} request.base Branch to merge into, e.g. "ls/v1.x".
 * @param {string} request.head Branch holding the backport.
 * @param {string} request.title
 * @param {string} request.body
 * @param {string[]} [request.labels]
 * @param {string} [request.cwd] Repository to work in.
 * @returns {Promise<{url: string}>} Where the pull request ended up.
 */
export async function createPullRequest({
  base,
  head,
  title,
  body,
  labels = [],
  cwd,
}) {
  // Every argument is one array entry, so nothing in a title can be read as a
  // shell command. No shell is started at all.
  const args = [
    'pr',
    'create',
    '--base',
    base,
    '--head',
    head,
    '--title',
    title,
    '--body',
    body,
  ];
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
 * @param {{cwd?: string}} [options]
 * @returns {Forge}
 */
export function createGithubForge({ cwd } = {}) {
  return {
    preflight: () => preflight({ cwd }),
    createPullRequest: (request) => createPullRequest({ ...request, cwd }),
  };
}
