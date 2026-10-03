// Load SUPPORT.yaml from disk.
//
// This is the one place Lifeline reads the support file. `src/core` stays pure
// (no file system), so the commands go through here instead.

import { createHash, randomUUID } from 'node:crypto';
import {
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseSupport } from './core/support.js';
import { error } from './core/problems.js';

/** The file name, fixed: Lifeline has no other configuration. */
export const SUPPORT_FILE = 'SUPPORT.yaml';

/** Used in the comment that gives editors a schema to autocomplete against. */
export const SCHEMA_URL =
  'https://raw.githubusercontent.com/lifelinejs/lifeline/devel/schema/support.schema.json';

/**
 * @typedef {Object} LoadedSupport
 * @property {'ok' | 'missing' | 'unreadable'} outcome Did we get a file at all?
 * @property {import('./core/support.js').Line[]} lines Lines we understood.
 * @property {import('./core/problems.js').Problem[]} problems Anything wrong.
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
      problems: [error(`Could not read ${path}: ${readError.message}`)],
    };
  }

  const parsed = parseSupport(text);
  return { outcome: 'ok', lines: parsed.lines, problems: parsed.problems };
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
 * The text goes to a temporary file in the same directory first and is then
 * renamed over SUPPORT.yaml, so a reader never sees half a file, and a write
 * that fails halfway never destroys the one that was there.
 *
 * @param {string} cwd
 * @param {string} text
 * @returns {Promise<string>} The path written to.
 */
export async function writeSupport(cwd, text) {
  const path = join(cwd, SUPPORT_FILE);
  // Same directory as the target, so the rename stays on one filesystem.
  const temporary = join(cwd, `.${SUPPORT_FILE}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, text, 'utf8');
    await rename(temporary, path);
  } catch (writeError) {
    // Whatever went wrong, do not leave the temporary file behind.
    await rm(temporary, { force: true }).catch(() => {});
    throw writeError;
  }
  return path;
}

/**
 * Write SUPPORT.yaml only when the directory has none yet.
 *
 * The `wx` flag makes the create exclusive: it fails with `EEXIST` instead of
 * clobbering a file that is already there, which is what `lifeline init`
 * relies on when it runs without `--force`. Keeping this separate from
 * writeSupport() means the replace path cannot be taken by accident.
 *
 * @param {string} cwd
 * @param {string} text
 * @returns {Promise<string>} The path written to.
 */
export async function createSupport(cwd, text) {
  const path = join(cwd, SUPPORT_FILE);
  await writeFile(path, text, { encoding: 'utf8', flag: 'wx' });
  return path;
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
