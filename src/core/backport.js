// Deciding what a backport should do, before any git command runs.
//
// Like the rest of src/core, this file is pure: it turns lines, a line name and
// a commit into a plan, and it returns problems instead of throwing them.

import { error } from './problems.js';
import { oneLine } from './support.js';

/** The stages a fix may be backported into. */
export const BACKPORT_STAGES = ['as', 'ls'];

/** Labels that make a backport to Life Support acceptable. */
export const LS_LABELS = ['security', 'critical'];

/**
 * Everything a backport is going to do. Nothing here has happened yet.
 *
 * @typedef {Object} Plan
 * @property {string} sha The commit to backport.
 * @property {string} shortSha Its short form, used in the branch name.
 * @property {string} version Target version, e.g. "1.x".
 * @property {string} stage Target stage, as or ls.
 * @property {string} baseRef Where the branch is created from, e.g. "origin/ls/v1.x".
 * @property {string} branch The backport branch to create.
 * @property {string[]} cherryPick Arguments for `git cherry-pick -x <sha>`.
 * @property {string[]} push Arguments for `git push <remote> <branch>`.
 * @property {string} title Pull request title.
 * @property {string} body Pull request body.
 * @property {string[]} labels Labels for the pull request.
 * @property {boolean} pullRequest False when the user passed --no-pr.
 */

/**
 * Find the line a backport is aimed at, and say no if it should not go there.
 *
 * A backport carries a fix from `devel` to a line that still takes fixes, so
 * the target has to be in Active Support or Life Support. A line in
 * development needs no backport, and a line that has ended takes none.
 *
 * @param {import('./support.js').Line[]} lines
 * @param {string} version Normalized version, e.g. "1.x".
 * @param {{label?: string | null}} [options]
 * @returns {{target: {version: string, stage: string, branch: string} | null,
 *   problems: import('./problems.js').Problem[]}}
 */
export function resolveTarget(lines, version, { label = null } = {}) {
  const { line, problems: notFound } = oneLine(lines, version);
  if (!line) {
    // Not listed at all, or listed more than once: either way there is no one
    // line to say whether it takes fixes, and the rules below would be reading
    // whichever entry happened to come first.
    return { target: null, problems: notFound };
  }

  if (line.stage === 'indev') {
    return {
      target: null,
      problems: [
        error(
          `"${version}" is in development on devel; fixes land there first, so it needs no backport.`,
        ),
      ],
    };
  }

  if (line.stage === 'el') {
    return {
      target: null,
      problems: [
        error(
          `"${version}" has reached End of Life; it no longer takes fixes.`,
        ),
      ],
    };
  }

  if (line.stage === 'ls' && !LS_LABELS.includes(label)) {
    return {
      target: null,
      problems: [
        error(
          `"${version}" is in Life Support, so it only takes ${LS_LABELS.join(' or ')} fixes; ` +
            `add --label ${LS_LABELS.join(' or --label ')}.`,
        ),
      ],
    };
  }

  if (!BACKPORT_STAGES.includes(line.stage)) {
    // Not reachable through parseSupport, which rejects unknown stages first.
    return {
      target: null,
      problems: [error(`"${version}" has the unknown stage "${line.stage}".`)],
    };
  }

  return {
    target: { version, stage: line.stage, branch: `${line.stage}/v${version}` },
    problems: [],
  };
}

/**
 * The default pull request title: "[v1.x] fix: something".
 * @param {string} version
 * @param {string} subject The subject line of the original commit.
 * @returns {string}
 */
export function pullRequestTitle(version, subject) {
  return `[v${version}] ${subject}`;
}

/**
 * The pull request body: which commit came from where, and where it landed.
 * @param {{version: string, stage: string, branch: string}} target
 * @param {{sha: string, shortSha: string}} commit
 * @param {{branchName: string, remote: string}} where
 * @returns {string}
 */
export function pullRequestBody(target, commit, where) {
  return [
    `Backport of \`${commit.shortSha}\` to the ${target.version} line (${target.stage}).`,
    '',
    `- Original commit: \`${commit.sha}\``,
    `- Target branch: \`${where.remote}/${target.branch}\``,
    `- Backport branch: \`${where.branchName}\``,
    '',
    `Created with \`lifeline backport ${commit.sha} --to v${target.version}\`.`,
  ].join('\n');
}

/**
 * Put the whole backport together: the branch to create, the cherry-pick to
 * run, and the pull request to open.
 *
 * @param {object} options
 * @param {string} options.sha Commit to backport, as git resolved it.
 * @param {string} options.shortSha Its short form, for the branch name.
 * @param {string} options.subject Its subject line.
 * @param {string} options.version Normalized target version, e.g. "1.x".
 * @param {string} options.stage Stage of the target line.
 * @param {string} options.branch Support branch of the target line.
 * @param {string} [options.remote] Remote to fetch and push to.
 * @param {string} [options.label] Label for the pull request.
 * @param {string} [options.branchName] Override for the backport branch.
 * @param {string} [options.title] Override for the pull request title.
 * @param {boolean} [options.pullRequest] False for --no-pr.
 * @returns {Plan}
 */
export function planBackport({
  sha,
  shortSha,
  subject,
  version,
  stage,
  branch,
  remote = 'origin',
  label = null,
  branchName = null,
  title = null,
  pullRequest = true,
}) {
  const target = { version, stage, branch };
  const name = branchName || `backport/${version}/${shortSha}`;

  return {
    sha,
    shortSha,
    version,
    stage,
    // The support branch, as it lives on the remote.
    baseRef: `${remote}/${branch}`,
    branch: name,
    cherryPick: ['cherry-pick', '-x', sha],
    push: ['push', remote, name],
    title: title || pullRequestTitle(version, subject),
    body: pullRequestBody(
      target,
      { sha, shortSha },
      { branchName: name, remote },
    ),
    labels: label ? [label] : [],
    pullRequest,
  };
}
