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
  withSupportLock,
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
} /**
 * Look a branch or tag up on the remote.
 *
 * `git ls-remote --heads|--tags` is asked for the exact ref (and, for a tag,
 * for the `^{}` line too), so the answer is about the remote itself: it
 * cannot be fooled by a local branch with the same name, nor by a
 * remote-tracking ref left behind by an earlier fetch. Lifecycle commands
 * mutate the remote, so their existence checks have to be about the remote.
 *
 * @param {object} options
 * @param {import('../git/git.js').Git} options.git
 * @param {string} options.remote
 * @param {'heads' | 'tags'} options.kind
 * @param {string} options.name Branch or tag name, e.g. "el/v1.x".
 * @returns {Promise<{sha: string, peeled: string | null} | null>} null when
 *   the remote does not have the ref. `sha` is the object the ref points at;
 *   `peeled` is the commit underneath it, for an annotated tag.
 * @throws {Error} When the remote cannot be asked; callers report it rather
 *   than guessing, because a wrong answer here either skips a push that was
 *   needed or walks over a ref that was not ours to touch.
 */
export async function remoteRef({ git, remote, kind, name }) {
  const ref = `refs/${kind}/${name}`;
  // The peel line only comes back when it is asked for by name.
  const output = await git.run([
    'ls-remote',
    `--${kind}`,
    remote,
    ref,
    `${ref}^{}`,
  ]);
  let sha = null;
  let peeled = null;
  for (const line of output.split('\n')) {
    const [object, refName] = line.trim().split(/\s+/);
    if (!object || !refName) {
      continue;
    }
    if (refName === ref) {
      sha = object;
    } else if (refName === `${ref}^{}`) {
      peeled = object;
    }
  }
  return sha === null ? null : { sha, peeled };
}

/**
 * Write SUPPORT.yaml with one line moved to its new stage.
 *
 * The file is read here, not taken from the snapshot the plan was built on.
 * Between that read and this write a command has fetched, asked the remote
 * about refs and pushed, which is long enough for another lifecycle command in
 * the same checkout to have moved a line of its own. Rendering the file from
 * the snapshot would put that line back where it was, and for a line that has
 * reached End of Life that means backports to it are allowed again. So the
 * transition is applied to what is on disk now, and every other line is left as
 * it is found.
 *
 * The line being moved is also compared with the snapshot. If it is no longer
 * where the plan found it, the push this write was to record has been overtaken
 * and nothing is written: the run says so instead.
 *
 * The reread, that comparison and the write all happen under the support lock,
 * so a second command in this checkout cannot read the same file and then write
 * over this one.
 *
 * The file is rendered from scratch, so it comes back in Lifeline's canonical
 * shape. Comments and any key Lifeline does not know about do not survive.
 *
 * @param {object} options
 * @param {string} options.cwd
 * @param {import('../core/support.js').Line[]} options.expectedLines The lines
 *   as the plan read them: what this write expects to still be there.
 * @param {string} options.version The line to move.
 * @param {string} options.stage Where it moved to.
 * @param {string} [options.eol] Its end-of-life date, when it has one.
 * @returns {Promise<{path: string | null,
 *   problems: import('../core/problems.js').Problem[]}>} The path written to, or
 *   null with problems when the lock could not be taken or the file changed
 *   underneath, and nothing was written.
 */
export async function writeMovedLine({
  cwd,
  expectedLines,
  version,
  stage,
  eol,
}) {
  const locked = await withSupportLock(cwd, async () => {
    const current = await readSupport(cwd);
    if (!current.ok) {
      return { path: null, problems: current.problems };
    }

    const overtaken = overtakenBy(expectedLines, current.lines, version);
    if (overtaken) {
      return { path: null, problems: [overtaken] };
    }

    const updated = current.lines.map((line) =>
      line.version === version
        ? { version: line.version, stage, eol, components: line.components }
        : line,
    );
    return {
      path: await writeSupport(cwd, renderSupportFile(updated)),
      problems: [],
    };
  });

  return locked.ok ? locked.value : { path: null, problems: [locked.problem] };
}

/**
 * Say that this write has been overtaken, or null when it has not.
 *
 * Only the two fields the transition depends on are compared. The stage says
 * whether this is still the move the plan made, and the date says which
 * end-of-life the file will record; anything else about the line is carried
 * over from what is on disk, so editing it does not stop the write.
 *
 * @param {import('../core/support.js').Line[]} expected
 * @param {import('../core/support.js').Line[]} current
 * @param {string} version
 * @returns {import('../core/problems.js').Problem | null}
 */
function overtakenBy(expected, current, version) {
  const now = current.find((line) => line.version === version);
  if (!now) {
    return error(
      `${version} is no longer listed in SUPPORT.yaml; the file changed while this command was running, so nothing was written.`,
    );
  }

  const then = expected.find((line) => line.version === version);
  if (!then) {
    return null;
  }
  if (then.stage === now.stage && (then.eol ?? null) === (now.eol ?? null)) {
    return null;
  }
  return error(
    `${describeLine(now)} in SUPPORT.yaml, not ${describeLine(then)} as this command expected; ` +
      'the file changed while this command was running, so nothing was written. ' +
      'Look at it, then run the command again.',
  );
}

/**
 * A line the way a message names it: "1.x is ls with eol 2027-01-01".
 * @param {import('../core/support.js').Line} line
 * @returns {string}
 */
function describeLine(line) {
  const ended = line.eol ? ` with eol ${line.eol}` : '';
  return `${line.version} is ${line.stage}${ended}`;
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
