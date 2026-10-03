// The rules of the support lifecycle, expressed as functions over plain data.
//
// Like the rest of `src/core`, this file is pure: no file reading, no git, no
// printing. Every rule returns a list of problems, and problems are returned,
// never thrown, so callers can decide how to present them.

import {
  STAGES,
  branchFor,
  eolTagName,
  lineFromBranch,
  sortLinesNewestFirst,
  stageIndex,
} from './stages.js';
import { daysUntilEol } from './dates.js';
import { error, warning } from './problems.js';
import { duplicateProblem } from './support.js';

/**
 * What Lifeline knows about a repository. Collected by a command (see
 * src/commands/check.js) and handed to the rules below.
 *
 * @typedef {Object} RepoFacts
 * @property {string[]} branches Local and remote-tracking branch names, with
 *   any `<remote>/` prefix already removed.
 * @property {string[]} tags Tag names, such as "v0.x-eol".
 * @property {Date} now "Today". Passed in so day counts do not depend on when
 *   the tests happen to run.
 */

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
 * Check the lines against the branches and tags that really exist.
 * @param {import('./support.js').Line[]} lines
 * @param {RepoFacts} repoFacts
 * @returns {import('./problems.js').Problem[]} problems, errors first
 */
export function checkAgainstRepo(lines, repoFacts) {
  return [
    ...checkUnlistedBranches(lines, repoFacts),
    ...checkStageMismatch(lines, repoFacts),
    ...checkMissingBranches(lines, repoFacts),
    ...checkPastEol(lines, repoFacts),
    ...checkEolTags(lines, repoFacts),
  ];
}

/**
 * The same version must not appear twice: one entry, one line. Commands that
 * would act on the line refuse a file like this; this is how it gets reported.
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
      problems.push(duplicateProblem(version, count));
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
 * eol says when a line stops getting fixes, so it belongs on a line in Life
 * Support, or on one that has already ended. Anywhere else, the stage and the
 * date disagree with each other.
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
    if (line.eol && line.stage !== 'ls' && line.stage !== 'el') {
      problems.push(
        warning(
          `"${line.version}" has an "eol" date but is ${line.stage}; "eol" belongs on an ls or el line.`,
        ),
      );
    }
  }
  return problems;
}

/**
 * A support branch that SUPPORT.yaml has never heard of: the file and the
 * repository have drifted apart.
 * @param {import('./support.js').Line[]} lines
 * @param {RepoFacts} repoFacts
 * @returns {import('./problems.js').Problem[]}
 */
function checkUnlistedBranches(lines, { branches }) {
  const listed = new Set(lines.map((line) => line.version));

  const problems = [];
  for (const name of branches) {
    const branchLine = lineFromBranch(name);
    if (branchLine && !listed.has(branchLine.version)) {
      problems.push(
        error(
          `branch ${name} exists, but ${branchLine.version} is not listed in SUPPORT.yaml.`,
        ),
      );
    }
  }
  return problems;
}

/**
 * A branch that is ahead of the line: "ls/v1.x" while the file says 1.x is as.
 * A branch at an earlier stage than the file claims is a snapshot left behind
 * by a transition (the ls/v1.x branch after 1.x ended on el/v1.x). Lifeline
 * never deletes refs, so that is expected history, not a problem; only a branch
 * ahead of the file means the file is stale.
 * @param {import('./support.js').Line[]} lines
 * @param {RepoFacts} repoFacts
 * @returns {import('./problems.js').Problem[]}
 */
function checkStageMismatch(lines, { branches }) {
  const listed = new Map(lines.map((line) => [line.version, line]));

  const problems = [];
  for (const name of branches) {
    const branchLine = lineFromBranch(name);
    const line = branchLine ? listed.get(branchLine.version) : undefined;
    if (!line) {
      continue;
    }
    if (stageIndex(branchLine.stage) <= stageIndex(line.stage)) {
      continue;
    }
    problems.push(
      error(
        `branch ${name} exists, but SUPPORT.yaml says ${line.version} is ${line.stage}; ` +
          `promote ${line.version} or update the file.`,
      ),
    );
  }
  return problems;
}

/**
 * A listed line whose branch has not been created yet. Not an error: support
 * branches are often created lazily, when the first fix needs one. An el line
 * is skipped: its archive is written once by `eol`, and the vN.x-eol tag is
 * what marks the end.
 * @param {import('./support.js').Line[]} lines
 * @param {RepoFacts} repoFacts
 * @returns {import('./problems.js').Problem[]}
 */
function checkMissingBranches(lines, { branches }) {
  const existing = new Set(branches);

  const problems = [];
  for (const line of lines) {
    if (line.stage === 'el') {
      continue;
    }
    const name = branchFor(line);
    if (name && !existing.has(name)) {
      problems.push(
        warning(`${name} does not exist yet; branches may be created lazily.`),
      );
    }
  }
  return problems;
}

/**
 * An ls line whose eol date has passed but which has not moved on to el.
 * @param {import('./support.js').Line[]} lines
 * @param {RepoFacts} repoFacts
 * @returns {import('./problems.js').Problem[]}
 */
function checkPastEol(lines, { now }) {
  const problems = [];
  for (const line of lines) {
    if (line.stage === 'el' || !line.eol) {
      continue;
    }
    const days = daysUntilEol(line.eol, now);
    if (days !== null && days < 0) {
      problems.push(
        warning(
          `"${line.version}" passed its eol date of ${line.eol} ${-days} days ago but is still ${line.stage}; move it to el.`,
        ),
      );
    }
  }
  return problems;
}

/**
 * A line that has ended should say when, with a vN.x-eol tag.
 * @param {import('./support.js').Line[]} lines
 * @param {RepoFacts} repoFacts
 * @returns {import('./problems.js').Problem[]}
 */
function checkEolTags(lines, { tags }) {
  const existing = new Set(tags);

  const problems = [];
  for (const line of lines) {
    if (line.stage !== 'el') {
      continue;
    }
    const tag = eolTagName(line.version);
    if (!existing.has(tag)) {
      problems.push(
        warning(
          `"${line.version}" is at stage el, but there is no ${tag} tag.`,
        ),
      );
    }
  }
  return problems;
}
