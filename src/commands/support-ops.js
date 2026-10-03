// The file and git steps that `promote` and `eol` both need.
//
// Both commands do the same three things before they touch anything: read
// SUPPORT.yaml, insist on a clean tree, and fetch so the branches they ask
// about are the ones the remote really has. That lives here once, so the two
// commands are left with only the parts that differ.

import { error } from '../core/problems.js';
import {
  loadSupport,
  renderSupportFile,
  writeSupport,
} from '../support-file.js';

/**
 * Read SUPPORT.yaml for a command that is about to change it.
 *
 * @param {string} cwd
 * @returns {Promise<{ok: boolean, lines: import('../core/support.js').Line[],
 *   problems: import('../core/problems.js').Problem[]}>} `ok` is false for a
 *   missing file, an unreadable one, or one with an error in it. All of those
 *   are configuration problems, which callers report with exit code 2.
 */
export async function readSupport(cwd) {
  const loaded = await loadSupport(cwd);
  const broken = loaded.problems.filter((problem) => problem.level === 'error');

  if (loaded.outcome !== 'ok' || broken.length > 0) {
    return { ok: false, lines: [], problems: loaded.problems };
  }
  return { ok: true, lines: loaded.lines, problems: [] };
}

/**
 * Check that the working tree is clean.
 *
 * These commands rewrite SUPPORT.yaml when they are told to, and a tree with
 * uncommitted changes means the user has work in progress that a rewrite could
 * get in the way of.
 *
 * @param {import('../git/git.js').Git} git
 * @returns {Promise<import('../core/problems.js').Problem[]>} Empty when fine.
 */
export async function checkCleanTree(git) {
  if (await git.isClean()) {
    return [];
  }
  return [
    error(
      'The working tree has uncommitted changes; commit or stash them first.',
    ),
  ];
}

/**
 * Fetch the remote, so the branch checks that follow see the truth.
 * @param {{git: import('../git/git.js').Git, remote: string}} options
 * @returns {Promise<import('../core/problems.js').Problem[]>} Empty when fine.
 */
export async function fetchFirst({ git, remote }) {
  try {
    await git.fetchRemote();
    return [];
  } catch (fetchError) {
    return [error(`git fetch ${remote} failed: ${gitMessage(fetchError)}`)];
  }
}

/**
 * Does the remote have this branch or tag?
 *
 * `git ls-remote --heads|--tags` asks the remote itself for the exact ref, so
 * the answer cannot be fooled by a local branch with the same name, nor by a
 * remote-tracking ref left behind by an earlier fetch. Lifecycle commands
 * mutate the remote, so their existence checks have to be about the remote.
 *
 * @param {object} options
 * @param {import('../git/git.js').Git} options.git
 * @param {string} options.remote
 * @param {'heads' | 'tags'} options.kind
 * @param {string} options.name Branch or tag name, e.g. "el/v1.x".
 * @returns {Promise<boolean>} True when the remote returns that ref.
 * @throws {Error} When the remote cannot be asked; callers report it rather
 *   than guessing, because a wrong answer here either skips a push that was
 *   needed or walks over a ref that was not ours to touch.
 */
export async function remoteRefExists({ git, remote, kind, name }) {
  const ref = `refs/${kind}/${name}`;
  const output = await git.run(['ls-remote', `--${kind}`, remote, ref]);
  return output.split('\n').some((line) => line.trim().split(/\s+/)[1] === ref);
}

/**
 * Write SUPPORT.yaml with `line` moved to its new stage.
 *
 * The file is rendered from scratch, so it comes back in Lifeline's canonical
 * shape. Comments and any key Lifeline does not know about do not survive.
 *
 * @param {object} options
 * @param {string} options.cwd
 * @param {import('../core/support.js').Line[]} options.lines All the lines.
 * @param {string} options.version The line to move.
 * @param {string} options.stage Where it moved to.
 * @param {string} [options.eol] Its end-of-life date, when it has one.
 * @returns {Promise<string>} The path written to.
 */
export async function writeMovedLine({ cwd, lines, version, stage, eol }) {
  const updated = lines.map((line) =>
    line.version === version
      ? { version: line.version, stage, eol, components: line.components }
      : line,
  );
  return writeSupport(cwd, renderSupportFile(updated));
}

/**
 * The part of a failed git command worth showing: what git said, rather than
 * the wrapper's "Command failed" line.
 * @param {Error & {stderr?: string}} failure What execFile rejected with.
 * @returns {string}
 */
export function gitMessage(failure) {
  return String(failure.stderr || '').trim() || failure.message.trim();
}
