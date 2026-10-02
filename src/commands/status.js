// Data for `lifeline status`.
//
// Note the argument style used by every command in src/commands/: a command
// receives what it needs as an object argument and returns data. It never
// reaches for globals and never prints, so a test can point it at a temporary
// directory (and later at a fake git or a fake forge) with no side effects.

import { branchFor, sortLinesNewestFirst } from '../core/stages.js';
import { checkLines } from '../core/checks.js';
import { daysUntilEol } from '../core/dates.js';
import { exitCodeFor } from '../exit-code.js';
import { loadSupport } from '../support-file.js';

/**
 * One line of the status table.
 *
 * @typedef {Object} StatusRow
 * @property {string} version For example "2.x".
 * @property {string} stage indev, as, ls or el.
 * @property {string | null} branch Branch name, or null if it cannot be built.
 * @property {boolean | null} exists Does the branch exist? null = unknown.
 * @property {string | null} eol YYYY-MM-DD, or null when the line has none.
 * @property {number | null} daysUntilEol Whole days to `eol`, null when none.
 */

/**
 * Everything `lifeline status` shows.
 *
 * @typedef {Object} Status
 * @property {'ok' | 'missing' | 'unreadable'} outcome Did we get a file at all?
 * @property {StatusRow[]} rows Newest line first.
 * @property {import('../core/problems.js').Problem[]} problems Anything wrong.
 * @property {0 | 1 | 2} exitCode
 */

/**
 * Read SUPPORT.yaml and turn each line into a row.
 *
 * @param {{cwd: string, git?: import('../git/git.js').Git, now?: Date}} options
 *   `git` is optional: without it the table has no exists column answer.
 * @returns {Promise<Status>}
 */
export async function readStatus({ cwd, git = null, now = new Date() }) {
  const loaded = await loadSupport(cwd);
  // If the directory is not a git repository we still want the table, so a
  // failed `git` call only costs us the exists column.
  const branches = await tryBranches(git);

  const rows = sortLinesNewestFirst(loaded.lines).map((line) => {
    const branch = branchFor(line);
    return {
      version: line.version,
      stage: line.stage,
      branch,
      exists:
        branches === null || branch === null ? null : branches.includes(branch),
      eol: line.eol ?? null,
      daysUntilEol: daysUntilEol(line.eol, now),
    };
  });

  // status, check and --json all show the same problem objects, so a line that
  // is in a strange state is worth a word here too.
  const problems = [...loaded.problems, ...checkLines(loaded.lines)];
  return {
    outcome: loaded.outcome,
    rows,
    problems,
    // 2 means "the support file is missing or broken": a configuration error.
    exitCode: exitCodeFor({ configProblems: loaded.problems, problems }),
  };
}

/**
 * Ask git for its branch list, or give up quietly.
 * @param {import('../git/git.js').Git | null} git
 * @returns {Promise<string[] | null>} null when git could not be asked.
 */
async function tryBranches(git) {
  if (!git) {
    return null;
  }
  try {
    return await git.branches();
  } catch {
    return null;
  }
}
