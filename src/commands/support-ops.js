// The file and git steps the commands that act on a release line share.
//
// `promote` and `eol` do the same three things before they touch anything: read
// SUPPORT.yaml, insist on a clean tree, and fetch so the branches they ask
// about are the ones the remote really has. That lives here once, so the two
// commands are left with only the parts that differ. `backport` borrows the
// remote question, since it acts on a line too.

import { error } from '../core/problems.js';
import { duplicateProblem } from '../core/support.js';
import { STAGES, stageIndex } from '../core/stages.js';
import {
  loadSupport,
  renderSupportFile,
  SUPPORT_CHANGED,
  withSupportLock,
  writeSupport,
} from '../support-file.js';

/** The prefix `ls-remote` prints a branch ref with. */
const HEADS_PREFIX = 'refs/heads/';

/**
 * Read SUPPORT.yaml for a command that is about to change it.
 *
 * @param {string} cwd
 * @returns {Promise<{ok: boolean, lines: import('../core/support.js').Line[],
 *   text: string | null,
 *   problems: import('../core/problems.js').Problem[]}>} `ok` is false for a
 *   missing file, an unreadable one, or one with an error in it. All of those
 *   are configuration problems, which callers report with exit code 2. `text`
 *   is the file as it was read, which is what a write has to find still there.
 */
export async function readSupport(cwd) {
  const loaded = await loadSupport(cwd);
  const broken = loaded.problems.filter((problem) => problem.level === 'error');

  if (loaded.outcome !== 'ok' || broken.length > 0) {
    return { ok: false, lines: [], text: null, problems: loaded.problems };
  }
  return { ok: true, lines: loaded.lines, text: loaded.text, problems: [] };
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
 * Ask the remote how far a line has moved, since it publishes refs first.
 *
 * `promote` and `eol` push the branch that marks the new stage before they
 * record it in SUPPORT.yaml, so a write that is overtaken, refused or cut short
 * leaves the file at an earlier stage than the remote has reached. `lifeline
 * check` reports that drift; this is how a command that is about to act on the
 * line asks the remote instead of taking the file's word for it.
 *
 * The question is put to the remote for the same reason `remoteRef` puts its
 * questions there: a branch of the same name in this checkout, or a
 * remote-tracking ref an earlier fetch left behind, is no evidence of what the
 * remote has now. Unlike the fetch, `ls-remote` changes nothing, so this is
 * asked on a dry run too.
 *
 * @param {object} options
 * @param {import('../git/git.js').Git} options.git
 * @param {string} options.remote
 * @param {string} options.version Normalized version, e.g. "1.x".
 * @param {string} options.stage The stage to look past: what the file puts the
 *   line in, except for a promotion, where it is the stage being promoted to so
 *   that the branch that promotion is about is not counted as drift.
 * @returns {Promise<string | null>} The support branch the remote has that is
 *   further along than `stage`, e.g. "el/v1.x", or null when the remote has not
 *   moved past it. Only the furthest one is returned: what matters is how far
 *   the line has gone, not how many stages it skipped.
 * @throws {Error} When the remote cannot be asked; callers report that rather
 *   than carry on, since the whole point is to not act on the file alone.
 */
export async function branchAhead({ git, remote, version, stage }) {
  const ahead = STAGES.slice(stageIndex(stage) + 1);
  if (ahead.length === 0) {
    return null;
  }
  const names = ahead.map((later) => `${later}/v${version}`);
  const output = await git.run([
    'ls-remote',
    '--heads',
    remote,
    ...names.map((name) => `refs/heads/${name}`),
  ]);

  let found = null;
  let furthest = -1;
  for (const line of output.split('\n')) {
    const [object, refName] = line.trim().split(/\s+/);
    if (!object || !refName || !refName.startsWith(HEADS_PREFIX)) {
      continue;
    }
    const index = names.indexOf(refName.slice(HEADS_PREFIX.length));
    if (index > furthest) {
      furthest = index;
      found = names[index];
    }
  }
  return found;
}

/**
 * What to say when the remote has moved past what SUPPORT.yaml says.
 *
 * The same drift reads the same way whichever command ran into it, so the
 * sentence lives here; only what the command did not do is its own.
 *
 * @param {object} options
 * @param {string} options.remote
 * @param {string} options.branch The branch the remote has, e.g. "el/v1.x".
 * @param {string} options.version Normalized version, e.g. "1.x".
 * @param {string} options.stage The stage the file puts the line in.
 * @param {string} options.nothing What this command did not do, in a few words,
 *   like "nothing was pushed".
 * @returns {import('../core/problems.js').Problem}
 */
export function behindProblem({ remote, branch, version, stage, nothing }) {
  return error(
    `${remote}/${branch} exists, but SUPPORT.yaml still says ${version} is ${stage}; ` +
      `the file is behind the remote, so ${nothing}. ` +
      'Run "lifeline check" to see what disagrees, and reconcile the file first.',
  );
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
 * over this one. The write itself also refuses to replace a file that is no
 * longer the one just read, which is what stops a writer that takes no lock (an
 * editor, another tool, another copy of Lifeline) from losing a change.
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

    // Two entries for the line is a contradiction, not a choice to make: the
    // map below would move both, and the plan that led here was made against
    // one of them.
    const listed = current.lines.filter((line) => line.version === version);
    if (listed.length > 1) {
      return {
        path: null,
        problems: [duplicateProblem(version, listed.length)],
      };
    }

    const updated = current.lines.map((line) =>
      line.version === version
        ? { version: line.version, stage, eol, components: line.components }
        : line,
    );

    let path;
    try {
      // The text just read is what the file has to still hold. The lock covers
      // the other Lifeline commands; this covers everything else that writes
      // the file without it, so a change made in the last moment is not put
      // back over.
      path = await writeSupport(cwd, renderSupportFile(updated), current.text);
    } catch (writeError) {
      if (writeError.code !== SUPPORT_CHANGED) {
        // A real failure to write: the caller reports what the file system said.
        throw writeError;
      }
      return { path: null, problems: [error(writeError.message)] };
    }

    return { path, problems: [] };
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
