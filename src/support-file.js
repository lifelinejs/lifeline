// Load SUPPORT.yaml from disk.
//
// This is the one place Lifeline reads the support file. `src/core` stays pure
// (no file system), so the commands go through here instead.

import { readFile, writeFile } from 'node:fs/promises';
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
 * @param {string} cwd
 * @param {string} text
 * @returns {Promise<string>} The path written to.
 */
export async function writeSupport(cwd, text) {
  const path = join(cwd, SUPPORT_FILE);
  await writeFile(path, text, 'utf8');
  return path;
}
