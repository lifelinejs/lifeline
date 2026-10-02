// `lifeline promote`: move a line along the lifecycle.
//
// indev -> as gives a line its own support branch, cut from devel.
// as -> ls graduates it to Life Support, cut from its own support branch.
//
// Like every command, this takes what it needs as an argument object and
// returns data. It never prints, and it never force-pushes anything.

import { planPromote, validatePromoteFlags } from '../core/lifecycle.js';
import { error } from '../core/problems.js';
import { normalizeLine } from '../core/stages.js';
import {
  checkCleanTree,
  fetchFirst,
  gitMessage,
  readSupport,
  writeMovedLine,
} from './support-ops.js';

/**
 * What `lifeline promote` did, or would have done.
 *
 * @typedef {Object} PromoteResult
 * @property {import('../core/lifecycle.js').TransitionPlan | null} plan
 * @property {boolean} pushed Did we create the branch on the remote?
 * @property {boolean} branchExisted Was the branch already there?
 * @property {boolean} written Did we rewrite SUPPORT.yaml?
 * @property {string | null} path The file written, when there is one.
 * @property {string[]} steps What to do next, or what was done.
 * @property {import('../core/problems.js').Problem[]} problems
 * @property {0 | 1 | 2} exitCode
 */

/**
 * Promote a line to Active Support or Life Support.
 *
 * @param {object} options
 * @param {string} options.cwd
 * @param {import('../git/git.js').Git} options.git
 * @param {string} [options.remote]
 * @param {string} options.version The line, "v1.x" or "1.x".
 * @param {'as' | 'ls'} [options.to] Where it is going; "as" by default.
 * @param {string | null} [options.date] The eol date, for --to ls.
 * @param {boolean} [options.write] Rewrite SUPPORT.yaml as well.
 * @param {boolean} [options.dryRun] Plan only, change nothing.
 * @param {boolean} [options.force] Accept a branch that already exists.
 * @returns {Promise<PromoteResult>}
 */
export async function promote({
  cwd,
  git,
  remote = 'origin',
  version,
  to = 'as',
  date = null,
  write = false,
  dryRun = false,
  force = false,
}) {
  // Bad flags first: they are usage errors, before any file or repository is
  // looked at.
  const flagProblems = validatePromoteFlags({ to, date });
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

  const planned = planPromote({
    lines: support.lines,
    version,
    to,
    date,
    remote,
  });
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
        error(
          `${plan.baseRef} does not exist, so there is nothing to promote from.`,
        ),
      ],
      exitCode: 1,
    });
  }

  const branchExisted = await git.branchExists(plan.branch);
  if (branchExisted && !force) {
    return result(plan, {
      branchExisted,
      problems: [
        error(
          `${remote}/${plan.branch} already exists; look at it, then pass --force to accept it as it is.`,
        ),
      ],
      exitCode: 1,
    });
  }

  if (dryRun) {
    return result(plan, {
      branchExisted,
      steps: nextSteps(plan, {
        dryRun: true,
        write,
        branchExisted,
        pushed: false,
      }),
      exitCode: 0,
    });
  }

  let pushed = false;
  if (!branchExisted) {
    try {
      await git.run(plan.push);
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
    try {
      path = await writeMovedLine({
        cwd,
        lines: support.lines,
        version: plan.version,
        stage: plan.to,
        eol: plan.line.eol,
      });
      written = true;
    } catch (writeError) {
      // The branch may already be pushed, so say what did happen.
      return result(plan, {
        pushed,
        branchExisted,
        problems: [
          error(`Could not write SUPPORT.yaml: ${writeError.message}`),
        ],
        steps: nextSteps(plan, {
          dryRun: false,
          write: false,
          branchExisted,
          pushed,
        }),
        exitCode: 1,
      });
    }
  }

  return result(plan, {
    pushed,
    branchExisted,
    written,
    path,
    steps: nextSteps(plan, { dryRun: false, write, branchExisted, pushed }),
    exitCode: 0,
  });
}

/**
 * The sentences the user reads after (or before) a promotion.
 * @param {import('../core/lifecycle.js').TransitionPlan} plan
 * @param {{dryRun: boolean, write: boolean, branchExisted: boolean, pushed: boolean}} state
 * @returns {string[]}
 */
function nextSteps(plan, { dryRun, write, branchExisted, pushed }) {
  const steps = [];

  if (branchExisted) {
    steps.push(`${plan.branch} already exists on the remote; left as it is.`);
  } else if (dryRun) {
    steps.push(`Would create ${plan.branch} from ${plan.baseRef} and push it.`);
  } else if (pushed) {
    steps.push(`Created ${plan.branch} from ${plan.baseRef}.`);
  }

  if (write && !dryRun) {
    steps.push(`Updated SUPPORT.yaml: ${plan.version} is now ${plan.to}.`);
  } else if (write) {
    steps.push(`Would set ${plan.version} to ${plan.to} in SUPPORT.yaml.`);
  } else {
    steps.push(
      `Set ${plan.version} to ${plan.to} in SUPPORT.yaml, then commit it.`,
    );
  }

  if (plan.to === 'as') {
    steps.push('Add the next line at stage indev when development moves on.');
  }
  steps.push(
    'Run "lifeline check" to confirm the file and the branches agree.',
  );
  return steps;
}

/**
 * A result with the defaults filled in.
 * @param {import('../core/lifecycle.js').TransitionPlan | null} plan
 * @param {Partial<PromoteResult>} fields
 * @returns {PromoteResult}
 */
function result(plan, fields) {
  return {
    plan,
    pushed: false,
    branchExisted: false,
    written: false,
    path: null,
    steps: [],
    problems: [],
    exitCode: 0,
    ...fields,
  };
}
