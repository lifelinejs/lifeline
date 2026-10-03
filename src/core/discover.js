// Guessing the support lines from the branches a repository already has.
//
// This is what `lifeline init` writes into a new SUPPORT.yaml. It is a guess,
// not a source of truth: `lifeline check` is what decides whether the result
// is right. Like the rest of src/core, it is pure.

import {
  DEVELOPMENT_BRANCH,
  lineFromBranch,
  majorOf,
  sortLinesNewestFirst,
  stageIndex,
} from './stages.js';

/**
 * Turn a list of branch names into support lines.
 *
 * Rules:
 * - `devel` means there is a line in development.
 * - `as|ls|el/vN.x` are support lines, one per version.
 * - Feature branches and backport branches are ignored: a backport branch is
 *   temporary and is never a support branch.
 *
 * The version of the `indev` line cannot be read off `devel`, so we take the
 * next major above every version we can see. With no support branches at all
 * that is `1.x`, which is what a brand new repository gets.
 *
 * @param {string[]} branches Branch names, with any `<remote>/` prefix removed.
 * @returns {import('./support.js').Line[]} Lines, newest first.
 */
export function linesFromBranches(branches) {
  /** @type {Map<string, string>} version -> stage */
  const stages = new Map();
  let hasDevel = false;

  for (const name of branches) {
    if (name === DEVELOPMENT_BRANCH) {
      hasDevel = true;
      continue;
    }
    const found = lineFromBranch(name);
    if (!found) {
      continue;
    }
    const known = stages.get(found.version);
    // If several branches exist for one version, keep the one that is
    // furthest along: as/v1.x and el/v1.x together mean 1.x has ended.
    if (!known || stageIndex(found.stage) > stageIndex(known)) {
      stages.set(found.version, found.stage);
    }
  }

  const lines = [...stages].map(([version, stage]) => ({ version, stage }));
  if (hasDevel) {
    lines.push({ version: nextVersionAbove(lines), stage: 'indev' });
  }
  return sortLinesNewestFirst(lines);
}

/**
 * The first major version above everything we can see.
 * @param {import('./support.js').Line[]} lines
 * @returns {string}
 */
function nextVersionAbove(lines) {
  const highest = Math.max(
    0,
    ...lines.map((line) => majorOf(line.version) ?? 0),
  );
  return `${highest + 1}.x`;
}
