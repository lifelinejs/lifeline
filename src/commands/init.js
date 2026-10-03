// Data for `lifeline init`.
//
// Like the other commands, this one takes what it needs as an argument object
// (`git` is the object from src/git/git.js or a fake) and returns data.

import { linesFromBranches } from '../core/discover.js';
import { error } from '../core/problems.js';
import {
  COULD_NOT_READ,
  createSupport,
  loadSupport,
  renderSupportFile,
  SUPPORT_CHANGED,
  withSupportLock,
  writeSupport,
} from '../support-file.js';

/**
 * What `lifeline init` did.
 *
 * @typedef {Object} InitResult
 * @property {boolean} written Did we write a file?
 * @property {string | null} path Where the file is, when there is one.
 * @property {string} text The file contents ("" when nothing was written).
 * @property {import('../core/support.js').Line[]} lines Lines we guessed.
 * @property {import('../core/problems.js').Problem[]} problems Anything wrong.
 * @property {0 | 1} exitCode
 */

/**
 * The lines a repository with nothing to go on gets.
 * @returns {import('../core/support.js').Line[]}
 */
export function starterLines() {
  return [{ version: '1.x', stage: 'indev' }];
}

/**
 * Write a starting SUPPORT.yaml for a repository.
 *
 * The lines come from the branches that exist: `devel` plus every
 * `as|ls|el/vN.x` branch. Nothing at all means a brand new repository, which
 * gets one `1.x` line in development.
 *
 * The whole run holds the support lock, from asking whether the file is there
 * to writing it. `init` writes the whole file like the other writers do, so
 * without the lock it could overwrite a line another command had just moved.
 *
 * @param {{cwd: string, git: import('../git/git.js').Git, force?: boolean}} options
 * @returns {Promise<InitResult>}
 */
export async function init({ cwd, git, force = false }) {
  const locked = await withSupportLock(cwd, () =>
    writeStarterFile({ cwd, git, force }),
  );
  if (locked.ok) {
    return locked.value;
  }
  return {
    written: false,
    path: null,
    text: '',
    lines: [],
    problems: [locked.problem],
    exitCode: 1,
  };
}

/**
 * The work `init` does, with the support lock already held.
 * @param {{cwd: string, git: import('../git/git.js').Git, force: boolean}} options
 * @returns {Promise<InitResult>}
 */
async function writeStarterFile({ cwd, git, force }) {
  // We read the file first only to find out whether it is there: anything other
  // than "missing" means it exists, and we must not clobber it silently.
  const existing = await loadSupport(cwd);
  if (existing.outcome !== 'missing' && !force) {
    return refuseExisting();
  }

  /** @type {import('../core/support.js').Line[]} */
  let lines = [];
  try {
    const guessed = linesFromBranches(await git.branches());
    // No support branches and no devel: this is a fresh repository.
    lines = guessed.length > 0 ? guessed : starterLines();
  } catch (gitError) {
    // Without branches there is nothing to guess from, and a wrong file is
    // worse than no file.
    return {
      written: false,
      path: null,
      text: '',
      lines: [],
      problems: [error(`Could not read the repository: ${gitError.message}`)],
      exitCode: 1,
    };
  }

  const text = renderSupportFile(lines);
  let path;
  try {
    // --force replaces the file, but only the one this run read: a change saved
    // while the branches were being read is somebody's work, and replacing it
    // would throw that work away. Without --force the create is exclusive, so a
    // SUPPORT.yaml that appears after the check above still cannot be lost.
    path = force
      ? await writeSupport(cwd, text, expectedContents(existing))
      : await createSupport(cwd, text);
  } catch (writeError) {
    if (writeError.code === 'EEXIST') {
      // Somebody (or some other run) wrote the file first: same answer as the
      // check at the top, with the same words.
      return refuseExisting();
    }
    return writeFailed(writeError);
  }

  return { written: true, path, text, lines, problems: [], exitCode: 0 };
}

/**
 * What the write has to find still there, from what this run read.
 *
 * @param {import('../support-file.js').LoadedSupport} loaded
 * @returns {string | null | typeof COULD_NOT_READ} The text the file held, null
 *   when there was none, or COULD_NOT_READ for the one case where there is
 *   nothing to compare: a file that could not be read. Replacing that is what
 *   --force is for, and refusing would leave the user with no way to get past
 *   it.
 */
function expectedContents(loaded) {
  if (loaded.outcome === 'ok') {
    return loaded.text;
  }
  return loaded.outcome === 'unreadable' ? COULD_NOT_READ : null;
}

/**
 * The answer for a write that did not happen: nothing was written, and either
 * what stopped it is worth saying in its own words or it goes in with the rest.
 *
 * @param {Error & {code?: string}} writeError
 * @returns {InitResult}
 */
function writeFailed(writeError) {
  return {
    written: false,
    path: null,
    text: '',
    lines: [],
    problems: [
      error(
        writeError.code === SUPPORT_CHANGED
          ? writeError.message
          : `Could not write SUPPORT.yaml: ${writeError.message}`,
      ),
    ],
    exitCode: 1,
  };
}

/**
 * The answer for "there is a SUPPORT.yaml here already and no --force":
 * write nothing, and say how to proceed. Shared by the check before we guess
 * at lines and by the exclusive create that follows it, so the two cannot
 * drift apart.
 * @returns {InitResult}
 */
function refuseExisting() {
  return {
    written: false,
    path: null,
    text: '',
    lines: [],
    problems: [
      error(
        'SUPPORT.yaml already exists. Look at it, and pass --force to write a new one over it.',
      ),
    ],
    exitCode: 1,
  };
}
