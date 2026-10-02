// The vocabulary of the support lifecycle: stages, branch names, ordering.
//
// This file is pure data and pure functions. It never reads files, never runs
// git and never prints anything.

// ESM note: relative imports must include the file extension (".js" here).

/** Every stage a line can be in, from newest to oldest support. */
export const STAGES = ['indev', 'as', 'ls', 'el'];

/** Short descriptions, used by `lifeline status` in later stages. */
export const STAGE_LABELS = {
  indev: 'in development',
  as: 'Active Support',
  ls: 'Life Support',
  el: 'End of Life',
};

/** The development branch: where the `indev` line lives. */
export const DEVELOPMENT_BRANCH = 'devel';

/** A line's version, e.g. "2.x". */
export const VERSION_PATTERN = /^\d+\.x$/;

/** How to recognise a support branch such as "as/v2.x". */
export const SUPPORT_BRANCH_PATTERN = /^(as|ls|el)\/v\d+\.x$/;

/**
 * Turn a version into its major number: "2.x" -> 2.
 * Returns null when the version does not look like "N.x".
 * @param {string} version
 * @returns {number | null}
 */
export function majorOf(version) {
  const match = /^(\d+)\.x$/.exec(version);
  return match ? Number(match[1]) : null;
}

/**
 * Position of a stage in the lifecycle: indev 0, as 1, ls 2, el 3.
 * Returns -1 for anything that is not a real stage.
 * @param {string} stage
 * @returns {number}
 */
export function stageIndex(stage) {
  return STAGES.indexOf(stage);
}

/**
 * The branch that holds a line: `devel` for `indev`, otherwise
 * "<stage>/v<major>.x" such as "as/v2.x".
 * Returns null when the stage is unknown.
 * @param {{version: string, stage: string}} line
 * @returns {string | null}
 */
export function branchFor(line) {
  if (line.stage === 'indev') {
    return DEVELOPMENT_BRANCH;
  }
  if (!SUPPORT_BRANCH_PATTERN.test(`${line.stage}/v${line.version}`)) {
    return null;
  }
  return `${line.stage}/v${line.version}`;
}

/**
 * Is this branch name a support branch such as "ls/v1.x"?
 * Note that backport/<line>/<sha> branches are NOT support branches.
 * @param {string} name
 * @returns {boolean}
 */
export function isSupportBranch(name) {
  return SUPPORT_BRANCH_PATTERN.test(name);
}

/**
 * Read a line out of a support branch name: "as/v2.x" -> 2.x at stage "as".
 * Returns null when the name is not a support branch.
 * @param {string} name
 * @returns {{version: string, stage: string} | null}
 */
export function lineFromBranch(name) {
  const match = /^(as|ls|el)\/v(\d+)\.x$/.exec(name);
  if (!match) {
    return null;
  }
  return { version: `${match[2]}.x`, stage: match[1] };
}

/**
 * Sort lines newest first (3.x, 2.x, 1.x, 0.x).
 * Does not modify the array it is given; returns a new one.
 * @template {{version: string}} T
 * @param {T[]} lines
 * @returns {T[]}
 */
export function sortLinesNewestFirst(lines) {
  return [...lines].sort(
    (a, b) => (majorOf(b.version) ?? 0) - (majorOf(a.version) ?? 0),
  );
}
