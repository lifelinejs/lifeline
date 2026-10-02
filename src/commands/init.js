// Data for `lifeline init`.
//
// Like the other commands, this one takes what it needs as an argument object
// (`git` is the object from src/git/git.js or a fake) and returns data.

import { linesFromBranches } from '../core/discover.js';
import { error } from '../core/problems.js';
import {
  loadSupport,
  renderSupportFile,
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
 * @param {{cwd: string, git: import('../git/git.js').Git, force?: boolean}} options
 * @returns {Promise<InitResult>}
 */
export async function init({ cwd, git, force = false }) {
  // We read the file first only to find out whether it is there: anything other
  // than "missing" means it exists, and we must not clobber it silently.
  const existing = await loadSupport(cwd);
  if (existing.outcome !== 'missing' && !force) {
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
  const path = await writeSupport(cwd, text);

  return { written: true, path, text, lines, problems: [], exitCode: 0 };
}
