// Deciding what a stage change should do, before any git command runs.
//
// `promote` moves a line forwards (indev -> as -> ls) and `eol` ends it
// (as | ls -> el). Both are the same shape of work: check the line may move
// there, work out which branch to create and where it comes from, and say what
// the SUPPORT.yaml entry should then say.
//
// Like the rest of src/core this file is pure. Problems come back as objects,
// never as exceptions, so callers decide how to present them.

import { DEVELOPMENT_BRANCH, normalizeLine, branchFor } from './stages.js';
import { error } from './problems.js';
import { isEolDate } from './support.js';

/** The stages `lifeline promote` can move a line to. */
export const PROMOTE_TARGETS = ['as', 'ls'];

/** The stage a line must be in before it can be promoted to a stage. */
const STAGE_BEFORE = {
  as: 'indev',
  ls: 'as',
};

/** End of Life is not a promotion; `lifeline eol` does that. */
export const END_OF_LIFE = 'el';

/**
 * What one stage change will do. Nothing here has happened yet.
 *
 * @typedef {Object} TransitionPlan
 * @property {string} version The line being moved, e.g. "1.x".
 * @property {string} from The stage it is in now.
 * @property {string} to The stage it moves to.
 * @property {string} branch The branch this creates, e.g. "as/v3.x".
 * @property {string} baseRef Where that branch is cut from, e.g. "origin/devel".
 * @property {string[]} push Arguments for the `git push` that creates it.
 * @property {import('./support.js').Line} line The entry SUPPORT.yaml should
 *   have afterwards.
 * @property {string} [tag] A tag to create at the same time (eol only).
 */

/**
 * Check the flags of `lifeline promote` on their own, before looking at the
 * support file. Anything found here is a usage error (exit code 2): the
 * arguments cannot describe a stage change at all.
 *
 * @param {{to?: string, date?: string | null}} options
 * @returns {import('./problems.js').Problem[]}
 */
export function validatePromoteFlags({ to = 'as', date = null }) {
  const problems = [];
  if (!PROMOTE_TARGETS.includes(to)) {
    problems.push(
      error(
        `Cannot promote to "${to}"; use --to ${PROMOTE_TARGETS.join(' or --to ')}, ` +
          `or "lifeline eol" to end a line.`,
      ),
    );
  }
  if (date && to === 'as') {
    problems.push(
      error(
        '--date does not apply to --to as; an "eol" date belongs on an ls line.',
      ),
    );
  }
  if (date && !isEolDate(date)) {
    problems.push(error(`"${date}" is not a date; use --date YYYY-MM-DD.`));
  }
  return problems;
}

/**
 * Check the flags of `lifeline eol` on their own. A bad date is a usage error.
 * @param {{date?: string | null}} options
 * @returns {import('./problems.js').Problem[]}
 */
export function validateEolFlags({ date = null }) {
  if (date && !isEolDate(date)) {
    return [error(`"${date}" is not a date; use --date YYYY-MM-DD.`)];
  }
  return [];
}

/**
 * Move a line one step or two along the lifecycle.
 *
 * Rules:
 * - `as` can only be reached from `indev`, and the branch is cut from
 *   `devel`, which is where that line's work has been.
 * - `ls` can only be reached from `as`, and the branch is cut from `as/vN.x`,
 *   so a line keeps exactly the code it had: it does not pick up anything new
 *   from `devel` on its way to Life Support.
 * - Life Support must say when it ends, so it needs an `eol` date.
 *
 * @param {object} options
 * @param {import('./support.js').Line[]} options.lines
 * @param {string} options.version Version as the user typed it, "v1.x" or "1.x".
 * @param {'as' | 'ls'} [options.to] Stage to move to, "as" by default.
 * @param {string | null} [options.date] An eol date, for --to ls only.
 * @param {string} [options.remote]
 * @returns {{plan: TransitionPlan | null,
 *   problems: import('./problems.js').Problem[]}}
 */
export function planPromote({
  lines,
  version,
  to = 'as',
  date = null,
  remote = 'origin',
}) {
  const found = lookup(lines, version);
  if (!found.line) {
    return { plan: null, problems: found.problems };
  }
  const line = found.line;

  if (!STAGE_BEFORE[to]) {
    // validatePromoteFlags() has already rejected anything that is not a
    // target; this keeps a direct caller from getting a nonsense answer.
    return {
      plan: null,
      problems: [error(`"${to}" is not a stage a line can be promoted to.`)],
    };
  }

  const expectedFrom = STAGE_BEFORE[to];
  if (line.stage !== expectedFrom) {
    return {
      plan: null,
      problems: [error(wrongStageMessage(line, expectedFrom))],
    };
  }

  const problems = [];
  let eol = line.eol;
  if (to === 'ls') {
    if (date) {
      // validatePromoteFlags() has already checked the shape of a given date.
      eol = date;
    } else if (!eol) {
      // Life Support must say when it ends, so a promotion to ls cannot go
      // ahead until there is a date.
      problems.push(
        error(
          'Life Support needs an end-of-life date; add --date YYYY-MM-DD, for example --date 2027-03-01.',
        ),
      );
    }
  }

  if (problems.length > 0) {
    return { plan: null, problems };
  }

  const branch = `${to}/v${line.version}`;
  // A new line in development comes from devel. A line graduating to Life
  // Support comes from its own Active Support branch, not from devel.
  const baseBranch =
    to === 'as'
      ? DEVELOPMENT_BRANCH
      : branchFor({ version: line.version, stage: line.stage });
  const baseRef = `${remote}/${baseBranch}`;

  return {
    plan: {
      version: line.version,
      from: line.stage,
      to,
      branch,
      baseRef,
      // A refspec, so the branch is created on the remote without a checkout.
      push: ['push', remote, `${baseRef}:refs/heads/${branch}`],
      line: { version: line.version, stage: to, eol },
    },
    problems: [],
  };
}

/**
 * End a line's life: freeze it, and record that it ended.
 *
 * Rules:
 * - Only a line in Active or Life Support can end. A line in development has
 *   not shipped, and a line that already ended cannot end twice.
 * - The `el/vN.x` branch is a frozen copy of the line, cut from wherever the
 *   line lives now, so the last state of the code is never lost.
 * - The `vN.x-eol` tag marks the moment, and `lifeline check` asks for it.
 *
 * @param {object} options
 * @param {import('./support.js').Line[]} options.lines
 * @param {string} options.version Version as the user typed it.
 * @param {string} [options.date] The day the line ends; today when omitted.
 * @param {string} [options.remote]
 * @returns {{plan: TransitionPlan | null,
 *   problems: import('./problems.js').Problem[]}}
 */
export function planEol({ lines, version, date, remote = 'origin' }) {
  const found = lookup(lines, version);
  if (!found.line) {
    return { plan: null, problems: found.problems };
  }
  const line = found.line;

  if (line.stage === 'indev') {
    return {
      plan: null,
      problems: [
        error(
          `"${line.version}" is in development, so it cannot reach End of Life; promote it first.`,
        ),
      ],
    };
  }
  if (line.stage === END_OF_LIFE) {
    return {
      plan: null,
      problems: [error(`"${line.version}" has already reached End of Life.`)],
    };
  }

  const problems = [];
  if (date !== undefined && date !== null && !isEolDate(date)) {
    problems.push(error(`"${date}" is not a date; use --date YYYY-MM-DD.`));
  }
  if (problems.length > 0) {
    return { plan: null, problems };
  }

  // The date the line ended: what the user said, or what it already said, or
  // today when neither is known.
  const eol = date ?? line.eol ?? today();
  const sourceBranch = branchFor(line);
  const sourceRef = `${remote}/${sourceBranch}`;
  const branch = `${END_OF_LIFE}/v${line.version}`;
  const tag = `v${line.version}-eol`;

  return {
    plan: {
      version: line.version,
      from: line.stage,
      to: END_OF_LIFE,
      branch,
      baseRef: sourceRef,
      // Two refspecs in one push: the frozen branch and the tag, both at the
      // same commit, so the tag can never point somewhere else.
      push: [
        'push',
        remote,
        `${sourceRef}:refs/heads/${branch}`,
        `${sourceRef}:refs/tags/${tag}`,
      ],
      line: { version: line.version, stage: END_OF_LIFE, eol },
      tag,
    },
    problems: [],
  };
}

/**
 * Find the line the user named, with the version normalised on the way.
 * @param {import('./support.js').Line[]} lines
 * @param {string} version As typed, "v1.x" or "1.x".
 * @returns {{line: import('./support.js').Line | null,
 *   problems: import('./problems.js').Problem[]}}
 */
function lookup(lines, version) {
  const normalized = normalizeLine(version);
  if (!normalized) {
    return {
      line: null,
      problems: [error(`"${version}" is not a line; use 1.x or v1.x.`)],
    };
  }
  const line = lines.find((candidate) => candidate.version === normalized);
  if (!line) {
    return {
      line: null,
      problems: [error(`"${normalized}" is not listed in SUPPORT.yaml.`)],
    };
  }
  return { line, problems: [] };
}

/**
 * Explain, in one sentence, why a line cannot be promoted from where it is.
 * @param {import('./support.js').Line} line
 * @param {string} expectedFrom
 * @returns {string}
 */
function wrongStageMessage(line, expectedFrom) {
  if (line.stage === END_OF_LIFE) {
    return `"${line.version}" has already reached End of Life.`;
  }
  if (line.stage === 'indev') {
    return `"${line.version}" is in development; promote it to as first, then to ls.`;
  }
  if (line.stage === 'ls') {
    return `"${line.version}" is already in Life Support; "lifeline eol" is what comes next.`;
  }
  return `"${line.version}" is ${line.stage}; promoting to that stage needs it to be ${expectedFrom}.`;
}

/** Today in UTC, as YYYY-MM-DD. */
function today() {
  return new Date().toISOString().slice(0, 10);
}
