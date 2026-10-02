// The rules of the support lifecycle, expressed as functions over plain data.
//
// Like the rest of `src/core`, this file is pure: no file reading, no git, no
// printing. Every rule returns a list of problems, and problems are returned,
// never thrown, so callers can decide how to present them.

import { STAGES, sortLinesNewestFirst, stageIndex } from './stages.js';
import { error, warning } from './problems.js';

/**
 * Check the lines of SUPPORT.yaml against each other.
 * These rules need nothing but the lines themselves.
 *
 * @param {import('./support.js').Line[]} lines
 * @returns {import('./problems.js').Problem[]} problems, errors first
 */
export function checkLines(lines) {
  return [
    ...checkDuplicateVersions(lines),
    ...checkStageOrdering(lines),
    ...checkStageCounts(lines),
    ...checkEolFields(lines),
  ];
}

/**
 * The same version must not appear twice: one entry, one line.
 * @param {import('./support.js').Line[]} lines
 * @returns {import('./problems.js').Problem[]}
 */
function checkDuplicateVersions(lines) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const line of lines) {
    counts.set(line.version, (counts.get(line.version) ?? 0) + 1);
  }

  const problems = [];
  for (const [version, count] of counts) {
    if (count > 1) {
      problems.push(
        error(
          `version "${version}" is listed ${count} times; list each line once.`,
        ),
      );
    }
  }
  return problems;
}

/**
 * Lines only move one way (indev -> as -> ls -> el), so a newer line can never
 * be further along in the lifecycle than an older one.
 * @param {import('./support.js').Line[]} lines
 * @returns {import('./problems.js').Problem[]}
 */
function checkStageOrdering(lines) {
  // Newest first: 3.x, 2.x, 1.x, 0.x.
  const sorted = sortLinesNewestFirst(lines);

  const problems = [];
  for (let index = 0; index < sorted.length - 1; index += 1) {
    const newer = sorted[index];
    const older = sorted[index + 1];
    const newerRank = stageIndex(newer.stage);
    const olderRank = stageIndex(older.stage);
    // An unknown stage was already reported by parseSupport; skip it here.
    if (newerRank < 0 || olderRank < 0) {
      continue;
    }
    if (newerRank > olderRank) {
      problems.push(
        error(
          `"${newer.version}" is ${newer.stage} but older line "${older.version}" is ` +
            `${older.stage}; stages only go ${STAGES.join(' -> ')} as versions increase.`,
        ),
      );
    }
  }
  return problems;
}

/**
 * How many lines may sit in each stage.
 * @param {import('./support.js').Line[]} lines
 * @returns {import('./problems.js').Problem[]}
 */
function checkStageCounts(lines) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const line of lines) {
    counts.set(line.stage, (counts.get(line.stage) ?? 0) + 1);
  }

  const problems = [];
  const indev = counts.get('indev') ?? 0;
  if (indev > 1) {
    problems.push(
      error(
        `${indev} lines are at stage indev; only the newest line may be in development.`,
      ),
    );
  }
  const as = counts.get('as') ?? 0;
  if (as > 1) {
    problems.push(
      warning(`${as} lines are at stage as; usually only one line is in AS.`),
    );
  }
  const ls = counts.get('ls') ?? 0;
  if (ls > 2) {
    problems.push(
      warning(
        `${ls} lines are at stage ls; usually at most two lines are in LS.`,
      ),
    );
  }
  return problems;
}

/**
 * eol belongs to an ls line: it is the day that line stops getting fixes.
 * @param {import('./support.js').Line[]} lines
 * @returns {import('./problems.js').Problem[]}
 */
function checkEolFields(lines) {
  const problems = [];
  for (const line of lines) {
    if (line.stage === 'ls' && !line.eol) {
      problems.push(
        warning(
          `"${line.version}" is in Life Support but has no "eol" date; add one, for example "eol: 2027-03-01".`,
        ),
      );
    }
    if (line.eol && line.stage !== 'ls') {
      problems.push(
        warning(
          `"${line.version}" has an "eol" date but is ${line.stage}; "eol" belongs on an ls line.`,
        ),
      );
    }
  }
  return problems;
}
