// `lifeline backport`: carry a fix from devel to a support branch.
//
// Like the other commands, this one takes what it needs as an argument object
// (`git` and `forge` are passed in, so tests use fakes and never touch the
// network) and returns data. Nothing here prints; the CLI does that.

import { planBackport, resolveTarget } from '../core/backport.js';
import { error, warning } from '../core/problems.js';
import { normalizeLine } from '../core/stages.js';
import { loadSupport } from '../support-file.js';

/**
 * What a backport attempt did, or would have done.
 *
 * @typedef {Object} BackportResult
 * @property {import('../core/backport.js').Plan | null} plan
 * @property {boolean} done Did the cherry-pick and push happen?
 * @property {boolean} pushed
 * @property {string | null} prUrl Where the pull request is, if one opened.
 * @property {{files: string[]} | null} conflict Files left unmerged, if any.
 * @property {string[]} steps What the user should do next, if anything.
 * @property {import('../core/problems.js').Problem[]} problems
 * @property {0 | 1 | 2} exitCode
 */

/**
 * Backport one commit onto a support branch.
 *
 * @param {object} options
 * @param {string} options.cwd
 * @param {import('../git/git.js').Git} options.git
 * @param {import('../forge/github.js').Forge} options.forge
 * @param {string} options.remote Remote to fetch from and push to.
 * @param {string} options.sha Commit to backport.
 * @param {string} options.to Target line, "v1.x" or "1.x".
 * @param {string} [options.label]
 * @param {string} [options.branchName]
 * @param {string} [options.title]
 * @param {boolean} [options.noPr]
 * @param {boolean} [options.dryRun]
 * @param {boolean} [options.allowUnmerged]
 * @returns {Promise<BackportResult>}
 */
export async function backport({
  cwd,
  git,
  forge,
  remote = 'origin',
  sha,
  to,
  label = null,
  branchName = null,
  title = null,
  noPr = false,
  dryRun = false,
  allowUnmerged = false,
}) {
  const loaded = await loadSupport(cwd);
  // A missing or broken support file is a configuration error, exit code 2.
  const configErrors = loaded.problems.filter(
    (problem) => problem.level === 'error',
  );
  if (loaded.outcome !== 'ok' || configErrors.length > 0) {
    return stopped(null, loaded.problems, 2);
  }

  const version = normalizeLine(to);
  if (!version) {
    return stopped(
      null,
      [error(`"${to}" is not a line; use --to 1.x or --to v1.x.`)],
      2,
    );
  }

  const { target, problems: targetProblems } = resolveTarget(
    loaded.lines,
    version,
    { label },
  );
  if (!target) {
    return stopped(null, targetProblems, 1);
  }

  if (!(await git.isClean())) {
    return stopped(
      null,
      [
        error(
          'The working tree has uncommitted changes; commit or stash them first.',
        ),
      ],
      1,
    );
  }

  /** @type {import('../git/git.js').Commit} */
  let commit;
  try {
    commit = await git.commit(sha);
  } catch {
    return stopped(
      null,
      [error(`"${sha}" is not a commit in this repository.`)],
      1,
    );
  }

  if (commit.parents.length > 1) {
    return stopped(
      null,
      [
        error(
          `${commit.shortSha} is a merge commit; lifeline cannot cherry-pick those yet.`,
        ),
      ],
      1,
    );
  }

  // Every check below is about the remote, so fetch first: without it they
  // would answer from refs left behind by some earlier fetch. A dry run
  // changes nothing, not even the remote-tracking refs, so it skips the fetch
  // and reports the refs as possibly stale further down.
  if (!dryRun) {
    try {
      await git.fetchRemote();
    } catch (fetchError) {
      return stopped(
        null,
        [error(`git fetch ${remote} failed: ${gitMessage(fetchError)}`)],
        1,
      );
    }
  }

  // A fix belongs on the development branch before it can travel anywhere.
  const develRef = `${remote}/devel`;
  if (!(await git.branchExists(develRef))) {
    return stopped(null, [error(`${develRef} does not exist.`)], 1);
  }
  if (!allowUnmerged && !(await git.isAncestor(commit.sha, develRef))) {
    return stopped(
      null,
      [
        error(
          `${commit.shortSha} is not on ${develRef}; land the fix there first, ` +
            'or pass --allow-unmerged if you are sure.',
        ),
      ],
      1,
    );
  }

  // The support branch has to be on the remote: the backport branch is cut
  // from there, not from the local copy.
  const baseRef = `${remote}/${target.branch}`;
  if (!(await git.branchExists(baseRef))) {
    return stopped(
      null,
      [error(`${baseRef} does not exist; create the support branch first.`)],
      1,
    );
  }

  const plan = planBackport({
    sha: commit.sha,
    shortSha: commit.shortSha,
    subject: commit.subject,
    version: target.version,
    stage: target.stage,
    branch: target.branch,
    remote,
    label,
    branchName,
    title,
    pullRequest: !noPr,
  });

  if (dryRun) {
    // Nothing was fetched, so the checks above answered from whatever the
    // last fetch left behind; say so rather than imply the remote was asked.
    return {
      ...emptyResult(plan),
      problems: [
        warning(`--dry-run does not fetch, so ${remote} refs may be stale.`),
      ],
      exitCode: 0,
    };
  }

  // Check the forge before changing anything: no branch, no half-done work.
  if (plan.pullRequest) {
    try {
      await forge.preflight();
    } catch (forgeError) {
      return stopped(plan, [error(forgeError.message)], 1);
    }
  }

  // Where the user was before, so a failure can put them back there.
  const previousBranch = await currentBranchName(git);

  try {
    await git.run(['checkout', '-b', plan.branch, plan.baseRef]);
  } catch (checkoutError) {
    return stopped(plan, [error(gitMessage(checkoutError))], 1);
  }

  try {
    await git.run(plan.cherryPick);
  } catch (pickError) {
    const files = await conflictedFiles(git);
    if (files.length > 0) {
      // Leave the repository mid-cherry-pick on purpose: the next steps all
      // build on that state, and `git cherry-pick --abort` is always there.
      return {
        ...emptyResult(plan),
        conflict: { files },
        problems: [
          error(
            `${commit.shortSha} does not apply cleanly onto ${plan.baseRef}.`,
          ),
        ],
        steps: conflictSteps(plan, files, remote, target.branch),
        exitCode: 1,
      };
    }
    // Not a conflict: nothing here is worth keeping, so put the repository
    // back on the branch the user started from and drop the half-made branch
    // rather than leaving them stranded on plan.branch.
    const cleanup = await undoBackportBranch(git, previousBranch, plan.branch);
    return {
      ...stopped(
        plan,
        [error(`git cherry-pick failed: ${gitMessage(pickError)}`)],
        1,
      ),
      steps: cleanup,
    };
  }

  try {
    await git.run(plan.push);
  } catch (pushError) {
    return stopped(
      plan,
      [
        error(
          `git push ${remote} ${plan.branch} failed: ${gitMessage(pushError)}`,
        ),
      ],
      1,
    );
  }

  if (!plan.pullRequest) {
    return {
      ...emptyResult(plan),
      done: true,
      pushed: true,
      steps: [
        `Pushed to ${remote}/${plan.branch}.`,
        `Open a pull request from ${plan.branch} to ${target.branch}.`,
      ],
      exitCode: 0,
    };
  }

  let prUrl = null;
  try {
    const request = await forge.createPullRequest({
      base: target.branch,
      head: plan.branch,
      title: plan.title,
      body: plan.body,
      labels: plan.labels,
    });
    prUrl = request.url;
  } catch (forgeError) {
    // The branch is pushed already, so say where to find it.
    return {
      ...emptyResult(plan),
      done: true,
      pushed: true,
      problems: [error(forgeError.message)],
      steps: [
        `Pushed to ${remote}/${plan.branch}, but no pull request was opened.`,
        `Open one from ${plan.branch} to ${target.branch}.`,
      ],
      exitCode: 1,
    };
  }

  return {
    ...emptyResult(plan),
    done: true,
    pushed: true,
    prUrl,
    steps: [`Pull request: ${prUrl}`],
    exitCode: 0,
  };
}

/**
 * The part of a failed git command worth showing: what git said, rather than
 * the wrapper's "Command failed" line.
 * @param {Error & {stderr?: string}} failure What execFile rejected with.
 * @returns {string}
 */
function gitMessage(failure) {
  return String(failure.stderr || '').trim() || failure.message.trim();
}

/**
 * The branch HEAD is on right now, or null when HEAD is detached.
 * @param {import('../git/git.js').Git} git
 * @returns {Promise<string | null>}
 */
async function currentBranchName(git) {
  try {
    const name = (
      await git.run(['symbolic-ref', '--quiet', '--short', 'HEAD'])
    ).trim();
    return name === '' ? null : name;
  } catch {
    return null;
  }
}

/**
 * Undo the backport branch after a cherry-pick that failed for anything other
 * than a conflict: clear any half-finished pick, go back to the branch the
 * user was on, and delete the branch that was cut for the backport.
 *
 * Every step is best effort. Whatever could not be undone comes back as a
 * line for the user to run, so a failure never leaves the repository stranded
 * on `plan.branch` without saying so.
 *
 * @param {import('../git/git.js').Git} git
 * @param {string | null} previousBranch Branch HEAD was on before, if any.
 * @param {string} branch The backport branch to drop.
 * @returns {Promise<string[]>} What is left to do; empty when all went.
 */
async function undoBackportBranch(git, previousBranch, branch) {
  try {
    // Also clears CHERRY_PICK_HEAD when the pick got far enough to leave one.
    // Git refuses when there is nothing to abort, which is fine here.
    await git.run(['cherry-pick', '--abort']);
  } catch {
    // Nothing in progress.
  }

  const missed = [];
  if (previousBranch) {
    try {
      await git.run(['checkout', previousBranch]);
    } catch {
      missed.push(`git checkout ${previousBranch}`);
    }
  }
  try {
    await git.run(['branch', '-D', branch]);
  } catch {
    missed.push(`git branch -D ${branch}`);
  }

  return missed.length === 0 ? [] : [`Clean up by hand: ${missed.join('; ')}`];
}

/**
 * The paths git could not merge, from `git diff --diff-filter=U`.
 * @param {import('../git/git.js').Git} git
 * @returns {Promise<string[]>}
 */
async function conflictedFiles(git) {
  try {
    const output = await git.run(['diff', '--name-only', '--diff-filter=U']);
    return output
      .split('\n')
      .map((name) => name.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Exactly what to type next, after a conflict.
 * @param {import('../core/backport.js').Plan} plan
 * @param {string[]} files
 * @param {string} remote
 * @param {string} base The support branch to open the pull request against.
 * @returns {string[]}
 */
function conflictSteps(plan, files, remote, base) {
  return [
    `1. Fix the conflicts in: ${files.join(', ')}`,
    '2. git add <the files you fixed>',
    '3. git cherry-pick --continue',
    `4. git push ${remote} ${plan.branch}`,
    `5. Open a pull request from ${plan.branch} to ${base}`,
    '   (or run "git cherry-pick --abort" to give up)',
  ];
}

/**
 * A result with nothing done in it, ready to spread over.
 * @param {import('../core/backport.js').Plan | null} plan
 * @returns {BackportResult}
 */
function emptyResult(plan) {
  return {
    plan,
    done: false,
    pushed: false,
    prUrl: null,
    conflict: null,
    steps: [],
    problems: [],
    exitCode: 0,
  };
}

/**
 * A result that stops early with a problem to show.
 * @param {import('../core/backport.js').Plan | null} plan
 * @param {import('../core/problems.js').Problem[]} problems
 * @param {0 | 1 | 2} exitCode
 * @returns {BackportResult}
 */
function stopped(plan, problems, exitCode) {
  return { ...emptyResult(plan), problems, exitCode };
}
