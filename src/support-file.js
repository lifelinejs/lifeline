// Load SUPPORT.yaml from disk.
//
// This is the one place Lifeline reads the support file. `src/core` stays pure
// (no file system), so the commands go through here instead.

import { createHash, randomUUID } from 'node:crypto';
import { link, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseSupport } from './core/support.js';
import { error } from './core/problems.js';

/** The file name, fixed: Lifeline has no other configuration. */
export const SUPPORT_FILE = 'SUPPORT.yaml';

/**
 * The error code for "somebody else wrote SUPPORT.yaml first".
 *
 * The support lock only covers Lifeline: an editor saving the file, another
 * tool, or another version of Lifeline all write without it. A writer that is
 * about to replace the whole file compares it with what it read and refuses,
 * rather than putting back over a change it never saw.
 */
export const SUPPORT_CHANGED = 'ECHANGED';

/**
 * What a writer passes when it could not read the file, so there is nothing to
 * compare its write against.
 *
 * Only `lifeline init --force` can reach this: it is the one writer told to
 * replace a file without having read it. Everywhere else the file is read
 * first, or the run stops.
 */
export const COULD_NOT_READ = Symbol('could not read SUPPORT.yaml');

/** Used in the comment that gives editors a schema to autocomplete against. */
export const SCHEMA_URL =
  'https://raw.githubusercontent.com/lifelinejs/lifeline/devel/schema/support.schema.json';

/**
 * @typedef {Object} LoadedSupport
 * @property {'ok' | 'missing' | 'unreadable'} outcome Did we get a file at all?
 * @property {import('./core/support.js').Line[]} lines Lines we understood.
 * @property {import('./core/problems.js').Problem[]} problems Anything wrong.
 * @property {string | null} text The file as it is on disk when we could read
 *   it, whatever we made of it. A writer has to find this still there before it
 *   replaces the file, or it would put back over a change made since.
 */

/**
 * Read and parse `<cwd>/SUPPORT.yaml`.
 * Never throws: a missing or broken file comes back as problems, because
 * callers decide whether that is an error or a warning.
 * @param {string} cwd Directory to read from.
 * @returns {Promise<LoadedSupport>}
 */
export async function loadSupport(cwd) {
  const path = join(cwd, SUPPORT_FILE);

  let text;
  try {
    // "utf8" makes readFile return a string instead of a Buffer of bytes.
    text = await readFile(path, 'utf8');
  } catch (readError) {
    if (readError.code === 'ENOENT') {
      return {
        outcome: 'missing',
        lines: [],
        text: null,
        problems: [
          error(
            `No ${SUPPORT_FILE} in ${cwd}. Run "lifeline init" to create one.`,
          ),
        ],
      };
    }
    return {
      outcome: 'unreadable',
      lines: [],
      text: null,
      problems: [error(`Could not read ${path}: ${readError.message}`)],
    };
  }

  const parsed = parseSupport(text);
  return {
    outcome: 'ok',
    lines: parsed.lines,
    text,
    problems: parsed.problems,
  };
}

/**
 * Render lines as the text of a SUPPORT.yaml file.
 *
 * The text is built here by hand rather than with the yaml package's
 * stringify(), so that the schema comment stays on top and versions keep
 * their quotes: `version: "2.x"`.
 *
 * @param {import('./core/support.js').Line[]} lines At least one line: an
 *   empty list would be read back as `lines:` with nothing under it.
 * @returns {string} File contents, ending in a newline.
 */
export function renderSupportFile(lines) {
  const header = `# yaml-language-server: $schema=${SCHEMA_URL}\n`;
  const entries = lines.map((line) => {
    // A list entry starts with "- " and every following key lines up under it.
    const fields = [
      `  - version: "${line.version}"`,
      `    stage: ${line.stage}`,
    ];
    if (line.eol) {
      fields.push(`    eol: ${line.eol}`);
    }
    // "components" is informational, but a command that rewrites the file
    // (promote, eol) must not throw it away, so it is written back out.
    if (line.components && line.components.length > 0) {
      fields.push(`    components:\n${renderComponents(line.components)}`);
    }
    return fields.join('\n');
  });
  return `${header}lines:\n${entries.join('\n')}\n`;
}

/**
 * A YAML list of strings, one per line, indented under its key. Each string is
 * quoted, so a component called "api: v2" cannot be read as a mapping.
 * @param {string[]} components
 * @returns {string} The list, without the key it goes under.
 */
function renderComponents(components) {
  return components
    .map((component) => `      - ${JSON.stringify(component)}`)
    .join('\n');
}

/**
 * Write SUPPORT.yaml into a directory, replacing any existing file.
 *
 * The file is replaced only while it still holds `expected`, so a writer that
 * read it a moment ago cannot put back over a change made since by something
 * that does not take the support lock, such as an editor, another tool, or
 * another copy of Lifeline. When the file has moved on this throws with the code
 * SUPPORT_CHANGED and writes nothing, so the change is still there to be read.
 *
 * The text goes to a temporary file in the same directory first and is then
 * renamed over SUPPORT.yaml, so a reader never sees half a file, and a write
 * that fails halfway never destroys the one that was there.
 *
 * @param {string} cwd
 * @param {string} text
 * @param {string | null | typeof COULD_NOT_READ} expected What the caller read:
 *   the text the file held, or null when there was no file. COULD_NOT_READ is
 *   for the one caller that could not read the file at all, so nothing is
 *   compared and the write goes ahead.
 * @returns {Promise<string>} The path written to.
 */
export async function writeSupport(cwd, text, expected) {
  return publish(cwd, text, { exclusive: false, expected });
}

/**
 * Write SUPPORT.yaml only when the directory has none yet.
 *
 * The create is exclusive: it fails with `EEXIST` instead of clobbering a file
 * that is already there, which is what `lifeline init` relies on when it runs
 * without `--force`. The check that `link` performs *is* the check that the
 * file is the one the caller looked at, so this needs no expectation of its own.
 * Keeping this separate from writeSupport() means the replace path cannot be
 * taken by accident.
 *
 * @param {string} cwd
 * @param {string} text
 * @returns {Promise<string>} The path written to.
 */
export async function createSupport(cwd, text) {
  return publish(cwd, text, { exclusive: true, expected: null });
}

/**
 * Put one whole file in place, so SUPPORT.yaml is never a half-written file.
 *
 * Three steps, in this order, and the order is the point:
 *
 * 1. The contents go to a temporary file and are flushed to disk (`sync`)
 *    before anything is published. A rename that survives a crash while its
 *    contents do not would leave SUPPORT.yaml truncated, and a truncated policy
 *    file reads as a broken repository rather than as an interrupted write.
 * 2. The name is published in one step: `rename` to replace, or `link` to
 *    create. `link` is what makes the create both atomic and exclusive: it
 *    fails with EEXIST rather than replacing a file that is already there, and
 *    SUPPORT.yaml never exists without its contents. It leaves the temporary
 *    file behind as a second name for the same file, which is why the
 *    temporary is unlinked afterwards.
 * 3. The directory itself is flushed, or a crash can undo the rename and leave
 *    the previous file in place under a name that says it is the new one.
 *
 * A run interrupted before step 2 leaves the previous SUPPORT.yaml untouched,
 * or none at all, and a hidden temporary file; never half of a file.
 *
 * `link` needs a file system with hard links. Every common one has them, and
 * where one does not, the create fails loudly with nothing written rather than
 * quietly falling back to a write that can be interrupted halfway.
 *
 * @param {string} cwd
 * @param {string} text
 * @param {{exclusive: boolean,
 *   expected: string | null | typeof COULD_NOT_READ}} options `exclusive` fails
 *   with EEXIST when SUPPORT.yaml is already there, instead of replacing it.
 *   `expected` is what the caller read, checked before the name is published.
 * @returns {Promise<string>} The path written to.
 */
async function publish(cwd, text, { exclusive, expected }) {
  const path = join(cwd, SUPPORT_FILE);
  // Same directory as the target, so the rename stays on one filesystem.
  const temporary = join(cwd, `.${SUPPORT_FILE}.${randomUUID()}.tmp`);
  let handle;
  try {
    // "wx" so a temporary file left behind by a killed run is never reused.
    handle = await open(temporary, 'wx');
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;

    if (exclusive) {
      await link(temporary, path);
      await rm(temporary, { force: true });
    } else {
      // The last thing before the name moves. Everything slow is already done,
      // so this is as close to the rename as the check can get.
      await assertUnchanged(path, expected);
      await rename(temporary, path);
    }
    await syncDirectory(cwd);
  } catch (writeError) {
    // Whatever went wrong, do not leave the temporary file behind. The file at
    // `path` is either untouched or already whole: it was never written to
    // directly.
    await rm(temporary, { force: true }).catch(() => {});
    throw writeError;
  } finally {
    await handle?.close().catch(() => {});
  }
  return path;
}

/**
 * Refuse to replace a file that is no longer the one the caller read.
 *
 * @param {string} path
 * @param {string | null | typeof COULD_NOT_READ} expected
 * @returns {Promise<void>}
 * @throws {Error} With the code SUPPORT_CHANGED, when the file has moved on.
 *   Anything else that goes wrong reading it is passed on: the write has not
 *   started, so the run can say what is wrong with the file instead.
 */
async function assertUnchanged(path, expected) {
  if (expected === COULD_NOT_READ) {
    return;
  }
  const now = await readFileOrNull(path);
  if (now === expected) {
    return;
  }
  const changed = new Error(
    `${SUPPORT_FILE} changed while this command was writing it, so nothing was written. ` +
      'Look at it, then run the command again.',
  );
  changed.code = SUPPORT_CHANGED;
  throw changed;
}

/**
 * The file as it is now, or null when there is none. A file that cannot be read
 * for any other reason is a real problem, and is passed on.
 * @param {string} path
 * @returns {Promise<string | null>}
 */
async function readFileOrNull(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (readError) {
    if (readError.code === 'ENOENT') {
      return null;
    }
    throw readError;
  }
}

/**
 * Flush a directory entry to disk, so a rename survives a crash.
 *
 * Best effort by necessity, not by choice: Windows cannot open a directory as
 * a file at all, and some other file systems refuse fsync. The file is already
 * written and published by the time this runs, so failing here would report a
 * write that did happen as one that did not. What is lost on such a file system
 * is the name, not the contents.
 *
 * @param {string} dir
 * @returns {Promise<void>}
 */
async function syncDirectory(dir) {
  let handle;
  try {
    handle = await open(dir, 'r');
    await handle.sync();
  } catch {
    // Nothing to undo and nothing to report: see above.
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Run `work` holding the support file, so that only one Lifeline command at a
 * time is deciding what SUPPORT.yaml says.
 *
 * Every writer reads the file, works out what it should say and writes the
 * whole thing back, and those are three steps. Without something between them,
 * two commands in one checkout can take them at the same time: both read the
 * same file, both find their own line where they left it, and the second write
 * puts the first one's line back — which for a line that has reached End of Life
 * means backports to it are allowed again. The lock is held across the reread,
 * the decision and the write, and `init` takes it too, so no writer can go
 * around it.
 *
 * The lock is a file created exclusively, so the file system decides who gets
 * it rather than Lifeline deciding. It lives in the system temp directory under
 * a name derived from the directory it guards: taking it never makes the working
 * tree look dirty to `git status`, never leaves anything in the user's branches,
 * and two clones are two directories and two locks.
 *
 * It only covers Lifeline, though: an editor saving the file, another tool, or
 * another copy of Lifeline writes without it. That is what the check in
 * publish() is for: the lock keeps two Lifeline commands apart, and the check
 * keeps a writer from replacing a file that changed under it either way.
 *
 * Not getting the lock is an error rather than a wait. A lock left behind by a
 * killed process would otherwise be indistinguishable from one held by a run in
 * progress, so the message names the file to look at.
 *
 * @template T
 * @param {string} cwd Directory to guard.
 * @param {() => Promise<T>} work What to do while the lock is held. It must not
 *   take the lock again.
 * @returns {Promise<{ok: true, value: T} | {ok: false,
 *   problem: import('./core/problems.js').Problem}>} `value` is whatever `work`
 *   returned; `problem` is why the lock could not be taken, and `work` was not
 *   run.
 */
export async function withSupportLock(cwd, work) {
  let path;
  try {
    path = await lockPath(cwd);
  } catch (pathError) {
    return {
      ok: false,
      problem: error(
        `Could not work out where to lock ${SUPPORT_FILE} in ${cwd}: ${pathError.message}`,
      ),
    };
  }

  let handle;
  try {
    // "wx" fails with EEXIST when the file is already there: that is the lock
    // doing its job, not a problem to work around.
    handle = await open(path, 'wx');
  } catch (lockError) {
    if (lockError.code === 'EEXIST') {
      return {
        ok: false,
        problem: error(
          `Another Lifeline command is writing ${SUPPORT_FILE} in ${cwd}; it is holding ${path}. ` +
            'Wait for it to finish and try again, or delete that file if you are sure nothing is running.',
        ),
      };
    }
    return {
      ok: false,
      problem: error(`Could not lock ${path}: ${lockError.message}`),
    };
  }

  try {
    // The process id, so a lock that is still there can be traced to a run.
    try {
      await handle.writeFile(`${process.pid}\n`, 'utf8');
    } catch (writeError) {
      return {
        ok: false,
        problem: error(`Could not write lock ${path}: ${writeError.message}`),
      };
    }
    return { ok: true, value: await work() };
  } finally {
    // Every way out releases: the value on its way back, or a throw.
    await handle.close().catch(() => {});
    await rm(path, { force: true }).catch(() => {});
  }
}

/**
 * Where the lock for one directory lives: the system temp directory, under a
 * name derived from the directory itself, so one repository always gets the
 * same file and two repositories never share one.
 * @param {string} cwd
 * @returns {Promise<string>}
 */
async function lockPath(cwd) {
  // realpath, so two spellings of the same directory (a symlink, a relative
  // path) cannot end up with two locks.
  const key = createHash('sha256')
    .update(await realpath(cwd))
    .digest('hex')
    .slice(0, 16);
  return join(tmpdir(), `lifeline-support-${key}.lock`);
}
