// Tests for `lifeline backport`.
//
// Every test builds a real throwaway git repository with a bare "origin", and
// a fake forge stands in for GitHub. The git commands really run; only the pull
// request is faked, so nothing reaches the network.

import assert from 'node:assert/strict';
import { stat, writeFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { backport } from '../src/commands/backport.js';
import { createGit } from '../src/git/git.js';
import {
  commitFiles,
  git,
  makeFakeForge,
  makeGitRepo,
  supportYaml,
} from './helpers.js';

/**
 * Set up a repository with devel, one support branch, and a commit waiting to
 * be backported.
 *
 * @param {object} [options]
 * @param {string} [options.support] Contents of SUPPORT.yaml.
 * @param {string[]} [options.branches]
 * @param {Record<string, Record<string, string>>} [options.branchFiles]
 * @param {Record<string, string>} [options.fix] The commit to backport.
 * @param {string} [options.message]
 * @returns {Promise<{cwd: string, sha: string, subject: string}>}
 */
async function setup({
  support = supportYaml([{ version: '1.x', stage: 'as' }]),
  branches = ['as/v1.x'],
  branchFiles = {},
  fix = { 'src/fix.js': 'export const fixed = true;\n' },
  message = 'fix: correct the flux capacitor',
} = {}) {
  const { cwd } = await makeGitRepo({
    branches,
    support,
    withRemote: true,
    branchFiles,
  });
  const sha = (await commitFiles(cwd, fix, message)).trim();
  // Give origin the fix too, so it is on devel there as well.
  await git(['push', 'origin', 'devel'], cwd);

  const result = await git(['log', '-1', '--format=%s'], cwd);
  return { cwd, sha, subject: result.trim() };
}

/**
 * Run a backport against a prepared repository.
 * @param {string} cwd
 * @param {object} [options]
 * @param {import('../src/forge/github.js').Forge} [options.forge]
 * @param {object} [options.overrides] Passed straight to backport().
 * @returns {Promise<{result: import('../src/commands/backport.js').BackportResult, forge: any}>}
 */
function run(cwd, { forge = makeFakeForge(), overrides = {} } = {}) {
  return backport({
    cwd,
    git: createGit({ cwd, remote: 'origin' }),
    forge,
    remote: 'origin',
    sha: overrides.sha ?? 'HEAD',
    to: 'v1.x',
    ...overrides,
  }).then((result) => ({ result, forge }));
}

/**
 * Is there something at this path?
 * @param {string} path
 * @returns {Promise<boolean>}
 */
async function fileExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Does this branch exist on the remote? */
async function remoteHasBranch(cwd, branch) {
  const heads = await git(['ls-remote', '--heads', 'origin'], cwd);
  return (
    heads.includes(`refs/heads/${branch}\n`) ||
    heads.includes(`refs/heads/${branch}\r`)
  );
}

describe('backport happy path', () => {
  it('cherry-picks onto the support branch and opens a pull request', async () => {
    const { cwd, sha, subject } = await setup();
    const { result, forge } = await run(cwd, { overrides: { sha } });

    assert.equal(result.exitCode, 0);
    assert.equal(result.done, true);
    assert.equal(result.pushed, true);
    assert.deepEqual(result.problems, []);

    // The branch is named after the line and the short commit.
    const short = result.plan.shortSha;
    assert.equal(result.plan.branch, `backport/1.x/${short}`);
    assert.equal(result.plan.baseRef, 'origin/as/v1.x');
    assert.ok(
      await remoteHasBranch(cwd, `backport/1.x/${short}`),
      'branch should be pushed',
    );

    // The cherry-pick is really on that branch, with the -x provenance line.
    const cherryPicked = await git(
      ['log', '-1', '--format=%s', `backport/1.x/${short}`],
      cwd,
    );
    assert.equal(cherryPicked.trim(), subject);
    const body = await git(
      ['log', '-1', '--format=%b', `backport/1.x/${short}`],
      cwd,
    );
    assert.match(body, /\(cherry picked from commit/);

    // And the pull request went to the support branch.
    assert.equal(forge.preflightCalls, 1);
    assert.equal(forge.calls.length, 1);
    assert.deepEqual(forge.calls[0].base, 'as/v1.x');
    assert.deepEqual(forge.calls[0].head, `backport/1.x/${short}`);
    assert.deepEqual(forge.calls[0].labels, []);
    assert.equal(result.prUrl, 'https://github.test/org/repo/pull/7');
  });

  it('defaults the title to the line and the original subject', async () => {
    const { cwd, sha } = await setup();
    const { forge } = await run(cwd, { overrides: { sha } });

    assert.equal(
      forge.calls[0].title,
      '[v1.x] fix: correct the flux capacitor',
    );
    assert.match(forge.calls[0].body, /Backport of/);
    assert.match(forge.calls[0].body, new RegExp(sha));
    assert.match(forge.calls[0].body, /Target branch: `origin\/as\/v1\.x`/);
  });

  it('accepts the line with or without the v', async () => {
    const { cwd, sha } = await setup();
    const { result } = await run(cwd, { overrides: { sha, to: '1.x' } });

    assert.equal(result.exitCode, 0);
    assert.equal(result.plan.branch.startsWith('backport/1.x/'), true);
  });

  it('honours --branch-name and --title', async () => {
    const { cwd, sha } = await setup();
    const { result, forge } = await run(cwd, {
      overrides: {
        sha,
        branchName: 'fix/flaky-test',
        title: 'Fix the flaky test',
      },
    });

    assert.equal(result.plan.branch, 'fix/flaky-test');
    assert.ok(await remoteHasBranch(cwd, 'fix/flaky-test'));
    assert.equal(forge.calls[0].head, 'fix/flaky-test');
    assert.equal(forge.calls[0].title, 'Fix the flaky test');
  });
});

describe('backport line rules', () => {
  it('refuses a line that is not listed', async () => {
    const { cwd, sha } = await setup();
    const { result, forge } = await run(cwd, {
      overrides: { sha, to: 'v9.x' },
    });

    assert.equal(result.exitCode, 1);
    assert.match(result.problems[0].message, /"9\.x" is not listed/);
    assert.equal(forge.preflightCalls, 0);
  });

  it('refuses a line that is still in development', async () => {
    const { cwd, sha } = await setup({
      support: supportYaml([{ version: '1.x', stage: 'indev' }]),
    });
    const { result } = await run(cwd, { overrides: { sha } });

    assert.equal(result.exitCode, 1);
    assert.match(result.problems[0].message, /in development on devel/);
  });

  it('refuses a line that has reached end of life', async () => {
    const { cwd, sha } = await setup({
      support: supportYaml([
        { version: '1.x', stage: 'el', eol: '2027-01-01' },
      ]),
      branches: ['el/v1.x'],
    });
    const { result } = await run(cwd, { overrides: { sha } });

    assert.equal(result.exitCode, 1);
    assert.match(result.problems[0].message, /End of Life/);
  });

  it('rejects a --to that is not a line', async () => {
    const { cwd, sha } = await setup();
    const { result } = await run(cwd, { overrides: { sha, to: 'banana' } });

    assert.equal(result.exitCode, 2);
    assert.match(result.problems[0].message, /is not a line/);
  });

  it('stops when SUPPORT.yaml is missing', async () => {
    const { cwd } = await makeGitRepo({
      branches: ['as/v1.x'],
      withRemote: true,
    });
    const { result } = await run(cwd);

    assert.equal(result.exitCode, 2);
    assert.match(result.problems[0].message, /SUPPORT\.yaml/);
  });
});

describe('backport safety checks', () => {
  it('refuses a dirty working tree', async () => {
    const { cwd, sha } = await setup();
    // An uncommitted change to a tracked file.
    await writeFile(`${cwd}/README.md`, '# test repository, edited\n', 'utf8');

    const { result, forge } = await run(cwd, { overrides: { sha } });

    assert.equal(result.exitCode, 1);
    assert.match(result.problems[0].message, /uncommitted changes/);
    assert.equal(forge.preflightCalls, 0);
    assert.equal(result.done, false);
  });

  it('refuses a commit that is not on devel', async () => {
    const { cwd } = await setup();
    // A commit that only exists on a side branch, never pushed to devel.
    await git(['checkout', '-b', 'side'], cwd);
    const sideSha = await commitFiles(
      cwd,
      { 'side.txt': 'side work\n' },
      'wip: side work',
    );

    const { result } = await run(cwd, { overrides: { sha: sideSha } });

    assert.equal(result.exitCode, 1);
    assert.match(result.problems[0].message, /is not on origin\/devel/);
    assert.match(result.problems[0].message, /--allow-unmerged/);
  });

  it('backports an unmerged commit with --allow-unmerged', async () => {
    const { cwd } = await setup();
    await git(['checkout', '-b', 'side'], cwd);
    const sideSha = await commitFiles(
      cwd,
      { 'side.txt': 'side work\n' },
      'wip: side work',
    );
    await git(['checkout', 'devel'], cwd);

    const { result, forge } = await run(cwd, {
      overrides: { sha: sideSha, allowUnmerged: true },
    });

    assert.equal(result.exitCode, 0);
    assert.equal(forge.calls.length, 1);
  });

  it('refuses a merge commit', async () => {
    const { cwd } = await setup();
    await git(['checkout', '-b', 'side'], cwd);
    const sideSha = await commitFiles(
      cwd,
      { 'side.txt': 'side work\n' },
      'wip: side work',
    );
    await git(['checkout', 'devel'], cwd);
    await git(['merge', '--no-ff', '-m', 'Merge side into devel', 'side'], cwd);
    const mergeSha = (await git(['rev-parse', 'HEAD'], cwd)).trim();
    assert.notEqual(mergeSha, sideSha);

    const { result } = await run(cwd, {
      overrides: { sha: mergeSha, allowUnmerged: true },
    });

    assert.equal(result.exitCode, 1);
    assert.match(result.problems[0].message, /merge commit/);
  });

  it("stops with git's own message when the branch is already there", async () => {
    const { cwd, sha } = await setup();
    await run(cwd, { overrides: { sha } });

    // A second backport of the same commit has no branch name left to take.
    const { result } = await run(cwd, { overrides: { sha } });

    assert.equal(result.exitCode, 1);
    assert.equal(result.done, false);
    assert.equal(result.pushed, false);
    // The message is git's, not our "Command failed" wrapper.
    assert.match(result.problems[0].message, /already exists/);
    assert.doesNotMatch(result.problems[0].message, /Command failed/);
  });

  it('refuses when the support branch is not on the remote', async () => {
    const { cwd, sha } = await setup({
      support: supportYaml([{ version: '1.x', stage: 'as' }]),
      branches: ['as/v1.x'],
    });
    // Remove the remote branch, so origin/as/v1.x does not exist.
    await git(['push', 'origin', '--delete', 'as/v1.x'], cwd);

    const { result } = await run(cwd, { overrides: { sha } });

    assert.equal(result.exitCode, 1);
    assert.match(
      result.problems[0].message,
      /origin\/as\/v1\.x does not exist/,
    );
  });
});

describe('backport life support labels', () => {
  it('refuses a life support line without a label', async () => {
    const { cwd, sha } = await setup({
      support: supportYaml([{ version: '1.x', stage: 'ls' }]),
      branches: ['ls/v1.x'],
    });
    const { result } = await run(cwd, { overrides: { sha } });

    assert.equal(result.exitCode, 1);
    assert.match(
      result.problems[0].message,
      /only takes security or critical fixes/,
    );
    assert.match(result.problems[0].message, /--label security/);
  });

  it('accepts a security label for a life support line', async () => {
    const { cwd, sha } = await setup({
      support: supportYaml([{ version: '1.x', stage: 'ls' }]),
      branches: ['ls/v1.x'],
    });
    const { result, forge } = await run(cwd, {
      overrides: { sha, label: 'security' },
    });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(forge.calls[0].base, 'ls/v1.x');
    assert.deepEqual(forge.calls[0].labels, ['security']);
  });

  it('passes a label through for active support too', async () => {
    const { cwd, sha } = await setup();
    const { result, forge } = await run(cwd, {
      overrides: { sha, label: 'bug' },
    });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(forge.calls[0].labels, ['bug']);
  });
});

describe('backport conflicts', () => {
  it('lists the files and the next steps, and leaves the state to fix', async () => {
    const { cwd, sha } = await setup({
      branchFiles: {
        'as/v1.x': { 'src/fix.js': 'export const fixed = "the old value";\n' },
      },
      fix: { 'src/fix.js': 'export const fixed = true;\n' },
    });
    const { result, forge } = await run(cwd, { overrides: { sha } });

    assert.equal(result.exitCode, 1);
    assert.equal(result.done, false);
    assert.equal(result.pushed, false);
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0].message, /does not apply cleanly/);
    assert.deepEqual(result.conflict.files, ['src/fix.js']);

    const steps = result.steps.join('\n');
    assert.match(steps, /src\/fix\.js/);
    assert.match(steps, /git add/);
    assert.match(steps, /git cherry-pick --continue/);
    assert.match(steps, /git push origin backport\/1\.x\//);
    assert.match(steps, /git cherry-pick --abort/);
    assert.match(steps, /from backport\/1\.x\/\w+ to as\/v1\.x/);
    assert.equal(forge.calls.length, 0);

    // We are still mid-cherry-pick, so --abort works. It puts us back on the
    // branch we created, with a clean tree.
    const inProgress = await fileExists(`${cwd}/.git/CHERRY_PICK_HEAD`);
    assert.equal(inProgress, true);
    await git(['cherry-pick', '--abort'], cwd);
    assert.equal(await fileExists(`${cwd}/.git/CHERRY_PICK_HEAD`), false);
    assert.equal((await git(['status', '--porcelain'], cwd)).trim(), '');
    const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
    assert.match(branch.trim(), /^backport\/1\.x\/\w+$/);
  });
});

describe('backport flags', () => {
  it('--dry-run prints a plan and changes nothing', async () => {
    const { cwd, sha } = await setup();
    const { result, forge } = await run(cwd, {
      overrides: { sha, dryRun: true },
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.done, false);
    assert.equal(result.pushed, false);
    assert.ok(result.plan, 'a dry run should still produce a plan');
    assert.equal(forge.preflightCalls, 0);
    assert.equal(forge.calls.length, 0);

    const heads = await git(['ls-remote', '--heads', 'origin'], cwd);
    assert.doesNotMatch(heads, /backport/);
    const current = await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
    assert.equal(current.trim(), 'devel');
  });

  it('--no-pr pushes and stops', async () => {
    const { cwd, sha } = await setup();
    const { result, forge } = await run(cwd, {
      overrides: { sha, noPr: true },
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.done, true);
    assert.equal(result.pushed, true);
    assert.equal(result.prUrl, null);
    assert.deepEqual(forge.calls, []);
    // No pull request to open means no need for gh at all.
    assert.equal(forge.preflightCalls, 0);

    assert.ok(await remoteHasBranch(cwd, result.plan.branch));
    const steps = result.steps.join('\n');
    assert.match(
      steps,
      /Open a pull request from backport\/1\.x\/\w+ to as\/v1\.x/,
    );
  });
});

describe('backport when the forge misbehaves', () => {
  it('stops before touching anything when gh is missing', async () => {
    const { cwd, sha } = await setup();
    const forge = makeFakeForge({
      failPreflight:
        'backport needs the GitHub CLI; install it and run `gh auth login`',
    });
    const { result } = await run(cwd, { overrides: { sha, forge } });

    assert.equal(result.exitCode, 1);
    assert.match(result.problems[0].message, /install it and run/);
    assert.equal(result.done, false);

    const local = await git(['branch', '--list', `backport/1.x/*`], cwd);
    assert.equal(local.trim(), '');
  });

  it('keeps the pushed branch when the pull request fails', async () => {
    const { cwd, sha } = await setup();
    const forge = makeFakeForge({ failCreate: 'gh pr create failed: nope' });
    const { result } = await run(cwd, { overrides: { sha, forge } });

    assert.equal(result.exitCode, 1);
    assert.equal(result.pushed, true);
    assert.match(result.problems[0].message, /gh pr create failed: nope/);
    assert.match(result.steps.join('\n'), /Pushed to origin\/backport\/1\.x\//);
    assert.match(
      result.steps.join('\n'),
      /Open one from backport\/1\.x\/\w+ to as\/v1\.x/,
    );
    assert.ok(await remoteHasBranch(cwd, result.plan.branch));
  });
});
