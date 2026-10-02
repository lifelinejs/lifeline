// Read and validate SUPPORT.yaml.
//
// This module is pure: it takes the *text* of the file and returns data. It
// never touches the disk and never prints. Problems come back as objects so
// that `check`, `status` and `--json` can all show the same messages.

import { parse as parseYaml } from 'yaml';
import { STAGES, VERSION_PATTERN } from './stages.js';
import { error, warning } from './problems.js';

/**
 * One release line, as written in SUPPORT.yaml.
 *
 * @typedef {Object} Line
 * @property {string} version Major version series, e.g. "2.x".
 * @property {'indev' | 'as' | 'ls' | 'el'} stage Where the line is in its life.
 * @property {string} [eol] Planned end-of-life date, YYYY-MM-DD (a string!).
 * @property {string[]} [components] Informational only; Lifeline ignores it.
 */

/**
 * Result of reading the file: the lines we understood, plus every problem we
 * found. `lines` is empty (or partial) when something is wrong.
 *
 * @typedef {Object} ParsedSupport
 * @property {Line[]} lines
 * @property {import('./problems.js').Problem[]} problems
 */

/** Keys we understand on a line entry. Anything else is only a warning. */
const LINE_KEYS = ['version', 'stage', 'eol', 'components'];

/** Keys we understand at the top level of the file. */
const ROOT_KEYS = ['lines'];

const EOL_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse the text of a SUPPORT.yaml file.
 * @param {string} text Contents of the file.
 * @returns {ParsedSupport}
 */
export function parseSupport(text) {
  let data;
  try {
    // The `yaml` package follows YAML 1.2, where a bare 2027-03-01 is a
    // *string* (YAML 1.2 has no timestamp type), so `eol` arrives as a string.
    data = parseYaml(text);
  } catch (yamlError) {
    return {
      lines: [],
      problems: [
        error(`SUPPORT.yaml is not valid YAML: ${firstLine(yamlError)}`),
      ],
    };
  }

  if (!isPlainObject(data)) {
    return {
      lines: [],
      problems: [
        error(
          'SUPPORT.yaml must be a mapping with a "lines" list at the top level.',
        ),
      ],
    };
  }

  const problems = [];
  pushUnknownKeyWarning('SUPPORT.yaml', data, ROOT_KEYS, problems);

  if (!Array.isArray(data.lines)) {
    problems.push(
      error('SUPPORT.yaml must have a "lines" list, for example "lines:".'),
    );
    return { lines: [], problems };
  }
  if (data.lines.length === 0) {
    problems.push(warning('SUPPORT.yaml lists no lines.'));
  }

  const lines = [];
  data.lines.forEach((entry, index) => {
    const line = readLine(entry, `lines[${index + 1}]`, problems);
    if (line) {
      lines.push(line);
    }
  });

  return { lines, problems };
}

/**
 * Validate one entry of the "lines" list. Pushes problems into `problems` and
 * returns the clean line object, or null when the entry cannot be used.
 * @param {unknown} entry
 * @param {string} where Human-readable place, like "lines[2]".
 * @param {import('./problems.js').Problem[]} problems
 * @returns {Line | null}
 */
function readLine(entry, where, problems) {
  if (!isPlainObject(entry)) {
    problems.push(
      error(`${where} must be a mapping with "version" and "stage".`),
    );
    return null;
  }

  pushUnknownKeyWarning(where, entry, LINE_KEYS, problems);

  let ok = true;

  if (
    typeof entry.version !== 'string' ||
    !VERSION_PATTERN.test(entry.version)
  ) {
    problems.push(error(`${where} needs a "version" string like "2.x".`));
    ok = false;
  }

  if (!STAGES.includes(entry.stage)) {
    problems.push(error(`${where} needs a "stage" of ${STAGES.join(', ')}.`));
    ok = false;
  }

  // readEol and readComponents return null when the value is present but wrong.
  const eol = readEol(entry.eol, where, problems);
  if (eol === null) {
    ok = false;
  }

  const components = readComponents(entry.components, where, problems);
  if (components === null) {
    ok = false;
  }

  if (!ok) {
    return null;
  }
  return { version: entry.version, stage: entry.stage, eol, components };
}

/**
 * Read the optional "eol" field. Returns undefined when it is absent.
 * @param {unknown} value
 * @param {string} where
 * @param {import('./problems.js').Problem[]} problems
 * @returns {string | null | undefined}
 */
function readEol(value, where, problems) {
  if (value === undefined || value === null) {
    return undefined;
  }
  // We want the *string* "2027-03-01": never a Date, never a number.
  if (typeof value !== 'string' || !EOL_PATTERN.test(value)) {
    problems.push(
      error(
        `${where} has an "eol" that is not a YYYY-MM-DD string (got ${describe(value)}).`,
      ),
    );
    return null;
  }
  if (Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    problems.push(
      error(`${where} has an "eol" of ${value}, which is not a real date.`),
    );
    return null;
  }
  return value;
}

/**
 * Read the optional, purely informational "components" field.
 * @param {unknown} value
 * @param {string} where
 * @param {import('./problems.js').Problem[]} problems
 * @returns {string[] | null | undefined}
 */
function readComponents(value, where, problems) {
  if (value === undefined || value === null) {
    return undefined;
  }
  const allStrings =
    Array.isArray(value) && value.every((item) => typeof item === 'string');
  if (!allStrings) {
    problems.push(
      error(`${where} has a "components" that is not a list of strings.`),
    );
    return null;
  }
  return value;
}

/**
 * Warn about keys we do not understand, so that typos are visible.
 * @param {string} where
 * @param {Record<string, unknown>} object
 * @param {string[]} known
 * @param {import('./problems.js').Problem[]} problems
 */
function pushUnknownKeyWarning(where, object, known, problems) {
  const extra = Object.keys(object).filter((key) => !known.includes(key));
  if (extra.length === 0) {
    return;
  }
  const quoted = extra.map((key) => `"${key}"`).join(', ');
  const supported = known.map((key) => `"${key}"`).join(', ');
  problems.push(
    warning(
      `Unknown key ${quoted} in ${where}; supported keys are ${supported}. Ignoring it.`,
    ),
  );
}

/** True for `{...}` objects, false for null and for arrays. */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A short, single-line description of an unexpected value. */
function describe(value) {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'a list';
  }
  if (value instanceof Date) {
    return 'a date';
  }
  return `${typeof value} ${JSON.stringify(value)}`;
}

/** Error messages from the yaml package can be long; keep the first line. */
function firstLine(err) {
  return String(err.message).split('\n')[0];
}
