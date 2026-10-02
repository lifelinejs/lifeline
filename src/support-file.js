// Load SUPPORT.yaml from disk.
//
// This is the one place Lifeline reads the support file. `src/core` stays pure
// (no file system), so the commands go through here instead.

import { readFile } from 'node:fs/promises';
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
