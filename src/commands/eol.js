// `lifeline eol`: end a line's life.
//
// Ending a line freezes the code on an `el/vN.x` branch, marks the moment with
// a `vN.x-eol` tag, and records the date in SUPPORT.yaml. A line that has ended
// takes no more fixes, so `lifeline backport` refuses it from then on.
//
// Like every command, this returns data and never prints. Nothing here
// force-pushes, and nothing is deleted.

import { planEol, validateEolFlags } from '../core/lifecycle.js';
import { error, warning } from '../core/problems.js';
import { normalizeLine } from '../core/stages.js';
import {
  checkCleanTree,
  fetchFirst,
  gitMessage,
  readSupport,
  remoteRef,
  writeMovedLine,
} from './support-ops.js';

/**
 * What `lifeline eol` did, or would have done.
 *
 * @typedef {Object} EolResult
 * @property {import('../core/lifecycle.js').TransitionPlan | null} plan
 * @property {boolean} pushed Did we create the branch and the tag?
 * @property {boolean} branchExisted Was `el/vN.x` already there?
 * @property {boolean} tagExisted Was `vN.x-eol` already there?
 * @property {boolean} written Did we rewrite SUPPORT.yaml?
 * @property {string | null} path The file written, when there is one.
 * @property {string[]} steps What to do next, or what was done.
 * @property {import('../core/problems.js').Problem[]} problems
 * @property {0 | 1 | 2} exitCode
 */

/**
 * End a line: freeze it and record the date.
 *
 * @param {object} options
 * @param {string} options.cwd
 * @param {import('../git/git.js').Git} options.git
 * @param {string} [options.remote]
 * @param {string} options.version The line, "v1.x" or "1.x".
 * @param {string | null} [options.date] The day it ends; today when omitted.
 * @param {boolean} [options.write] Rewrite SUPPORT.yaml as well.
 * @param {boolean} [options.dryRun] Plan only, change nothing.
 * @param {boolean} [options.force] Accept a branch or tag that already exists.
 * @returns {Promise<EolResult>}
 */
export async function eol({
  cwd,
  git,
  remote = 'origin',
  version,
  date = null,
  write = false,
  dryRun = false,
  force = false,
}) {
  const flagProblems = validateEolFlags({ date });
  if (flagProblems.length > 0) {
    return result(null, { problems: flagProblems, exitCode: 2 });
  }

  // A word that is not a line at all is a usage error, before anything else.
  if (!normalizeLine(version)) {
    return result(null, {
      problems: [error(`"${version}" is not a line; use 1.x or v1.x.`)],
      exitCode: 2,
    });
  }

  const support = await readSupport(cwd);
  if (!support.ok) {
    return result(null, { problems: support.problems, exitCode: 2 });
  }

  const planned = planEol({ lines: support.lines, version, date, remote });
  if (!planned.plan) {
    return result(null, { problems: planned.problems, exitCode: 1 });
  }
  const plan = planned.plan;

  const dirty = await checkCleanTree(git);
  if (dirty.length > 0) {
    return result(plan, { problems: dirty, exitCode: 1 });
  }

  const fetchProblems = await fetchFirst({ git, remote });
  if (fetchProblems.length > 0) {
    return result(plan, { problems: fetchProblems, exitCode: 1 });
  }

  if (!(await git.branchExists(plan.baseRef))) {
    return result(plan, {
      problems: [
        error(`${plan.baseRef} does not exist, so there is no code to freeze.`),
      ],
      exitCode: 1,
    });
  }

  // Both refs are made on the remote, so ask the remote about both. An
  // unqualified name would check this checkout instead: a branch or tag that
  // exists only on the remote would slip past the refusal, and one that
  // exists only here would skip the push that is needed to create it there.
  // A lookup that cannot be answered stops the command: guessing here would
  // either push over a ref that is not ours or skip a push that is needed.
  let branchExisted = false;
  let remoteBranch = null;
  let remoteTag = null;
  let asked = '';
  try {
    asked = `--heads ${remote} refs/heads/${plan.branch}`;
    remoteBranch = await remoteRef({
      git,
      remote,
      kind: 'heads',
      name: plan.branch,
    });
    branchExisted = remoteBranch !== null;
    asked = `--tags ${remote} refs/tags/${plan.tag}`;
    remoteTag = await remoteRef({
      git,
      remote,
      kind: 'tags',
      name: plan.tag,
    });
  } catch (lsError) {
    return result(plan, {
      branchExisted,
      problems: [
        error(`git ls-remote ${asked} failed: ${gitMessage(lsError)}`),
      ],
      exitCode: 1,
    });
  }
  const tagExisted = remoteTag !== null;

  // Both frozen refs are already there, so --force would accept them as they
  // are. If they point at different commits the freeze is inconsistent
  // already, and that deserves a word whether or not the run goes ahead.
  const disagreements = [];
  if (branchExisted && tagExisted) {
    const tagCommit = remoteTag.peeled ?? remoteTag.sha;
    if (tagCommit !== remoteBranch.sha) {
      disagreements.push(
        warning(
          `${plan.branch} and ${plan.tag} point at different commits on ${remote}; ` +
            'the freeze they describe does not agree. Look at them before relying on it.',
        ),
      );
    }
  }

  if ((branchExisted || tagExisted) && !force) {
    const already = [
      branchExisted ? `${remote}/${plan.branch}` : null,
      tagExisted ? plan.tag : null,
    ].filter(Boolean);
    return result(plan, {
      branchExisted,
      tagExisted,
      problems: [
        error(
          `${already.join(' and ')} already exist${already.length === 1 ? 's' : ''}; look at them, then pass --force to accept them as they are.`,
        ),
        ...disagreements,
      ],
      exitCode: 1,
    });
  }

  if (dryRun) {
    return result(plan, {
      branchExisted,
      tagExisted,
      problems: disagreements,
      steps: nextSteps(plan, {
        dryRun: true,
        write,
        branchExisted,
        tagExisted,
        pushed: false,
      }),
      exitCode: 0,
    });
  }

  // Push only what is missing. Nothing is ever overwritten, even with --force.
  //
  // The frozen branch and the tag have to describe one snapshot, so the
  // source of a missing ref is chosen carefully:
  // - neither exists: both are cut from baseRef in one atomic push, so one
  //   cannot be published without the other;
  // - only the tag is missing: it marks the branch that was already frozen,
  //   not a line branch that may have advanced since;
  // - only the branch is missing: it is cut from the tag that marks the end.
  const refspecs = [];
  if (!branchExisted && !tagExisted) {
    refspecs.push(`${plan.baseRef}:refs/heads/${plan.branch}`);
    refspecs.push(`${plan.baseRef}:refs/tags/${plan.tag}`);
  } else if (branchExisted && !tagExisted) {
    refspecs.push(`${remote}/${plan.branch}:refs/tags/${plan.tag}`);
  } else if (!branchExisted && tagExisted) {
    const tagCommit = remoteTag.peeled ?? remoteTag.sha;
    try {
      await git.run(['cat-file', '-e', `${tagCommit}^{commit}`]);
    } catch {
      return result(plan, {
        problems: [
          error(
            `${plan.tag} is on ${remote} but not in this checkout, so ${plan.branch} cannot be cut from it here; ` +
              `run "git fetch ${remote} tag ${plan.tag}" and try again.`,
          ),
          ...disagreements,
        ],
        exitCode: 1,
      });
    }
    refspecs.push(`${tagCommit}:refs/heads/${plan.branch}`);
  }

  let pushed = false;
  if (refspecs.length > 0) {
    try {
      // A fresh freeze runs the plan's own push: two refspecs, atomic, so
      // neither lands without the other. A recovery pushes its one ref,
      // which lands or fails on its own.
      await git.run(
        refspecs.length > 1 ? plan.push : ['push', remote, ...refspecs],
      );
      pushed = true;
    } catch (pushError) {
      return result(plan, {
        problems: [error(`git push failed: ${gitMessage(pushError)}`)],
        exitCode: 1,
      });
    }
  }

  let written = false;
  let path = null;
  if (write) {
    let move;
    try {
      move = await writeMovedLine({
        cwd,
        expectedLines: support.lines,
        version: plan.version,
        stage: plan.to,
        eol: plan.line.eol,
      });
    } catch (writeError) {
      move = {
        path: null,
        problems: [
          error(`Could not write SUPPORT.yaml: ${writeError.message}`),
        ],
      };
    }
    path = move.path;
    written = move.path !== null;
    if (move.problems.length > 0) {
      // The freeze may already be pushed, so say what did happen.
      return result(plan, {
        pushed,
        branchExisted,
        tagExisted,
        problems: [...move.problems, ...disagreements],
        steps: nextSteps(plan, {
          dryRun: false,
          write: false,
          branchExisted,
          tagExisted,
          pushed,
        }),
        exitCode: 1,
      });
    }
  }

  return result(plan, {
    pushed,
    branchExisted,
    tagExisted,
    written,
    path,
    problems: disagreements,
    steps: nextSteps(plan, {
      dryRun: false,
      write,
      branchExisted,
      tagExisted,
      pushed,
    }),
    exitCode: 0,
  });
}

/**
 * The sentences the user reads after (or before) ending a line.
 * @param {import('../core/lifecycle.js').TransitionPlan} plan
 * @param {{dryRun: boolean, write: boolean, remote: string,
 *   branchExisted: boolean, tagExisted: boolean, pushed: boolean}} state
 * @returns {string[]}
 */
function nextSteps(plan, { dryRun, write, branchExisted, tagExisted, pushed }) {
  const steps = [];

  if (branchExisted) {
    steps.push(`${plan.branch} already exists on the remote; left as it is.`);
  } else if (dryRun) {
    steps.push(`Would create ${plan.branch} from ${plan.baseRef} and push it.`);
  } else if (pushed) {
    // No "cut from": a recovery may have finished the freeze from the ref
    // that already existed rather than from the line branch.
    steps.push(`Froze ${plan.version} on ${plan.branch}.`);
  }

  if (tagExisted) {
    steps.push(`${plan.tag} already exists; left as it is.`);
  } else if (dryRun) {
    steps.push(`Would tag ${plan.baseRef} as ${plan.tag}.`);
  } else if (pushed) {
    steps.push(`Tagged ${plan.tag}.`);
  }

  if (write && !dryRun) {
    steps.push(
      `Updated SUPPORT.yaml: ${plan.version} is now el with eol ${plan.line.eol}.`,
    );
  } else if (write) {
    steps.push(
      `Would set ${plan.version} to el with eol ${plan.line.eol} in SUPPORT.yaml.`,
    );
  } else {
    steps.push(
      `Set ${plan.version} to el with eol ${plan.line.eol} in SUPPORT.yaml, then commit it.`,
    );
  }

  steps.push(`Check for pull requests still open against ${plan.baseRef}.`);
  steps.push(
    `Backports to ${plan.version} are now refused; it no longer takes fixes.`,
  );
  steps.push(
    'Run "lifeline check" to confirm the file and the branches agree.',
  );
  return steps;
}

/**
 * A result with the defaults filled in.
 * @param {import('../core/lifecycle.js').TransitionPlan | null} plan
 * @param {Partial<EolResult>} fields
 * @returns {EolResult}
 */
function result(plan, fields) {
  return {
    plan,
    pushed: false,
    branchExisted: false,
    tagExisted: false,
    written: false,
    path: null,
    steps: [],
    problems: [],
    exitCode: 0,
    ...fields,
  };
}
