// Tests for src/core/backport.js: the rules about what a backport is allowed
// to do. Nothing here runs git.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  normalizeLine,
  planBackport,
  pullRequestBody,
  pullRequestTitle,
  resolveTarget,
} from '../src/core/backport.js';

describe('normalizeLine', () => {
  it('accepts a line with or without the v', () => {
    assert.equal(normalizeLine('v1.x'), '1.x');
    assert.equal(normalizeLine('1.x'), '1.x');
    assert.equal(normalizeLine('  v10.x '), '10.x');
  });

  it('rejects anything that is not a line', () => {
    assert.equal(normalizeLine('banana'), null);
    assert.equal(normalizeLine('1.2.3'), null);
    assert.equal(normalizeLine(''), null);
  });
});

describe('resolveTarget', () => {
  const lines = [
    { version: '3.x', stage: 'indev' },
    { version: '2.x', stage: 'as' },
    { version: '1.x', stage: 'ls' },
    { version: '0.x', stage: 'el' },
  ];

  it('finds an active support line and its branch', () => {
    const { target, problems } = resolveTarget(lines, '2.x');

    assert.deepEqual(target, {
      version: '2.x',
      stage: 'as',
      branch: 'as/v2.x',
    });
    assert.deepEqual(problems, []);
  });

  it('says no to a line that is not listed', () => {
    const { target, problems } = resolveTarget(lines, '9.x');

    assert.equal(target, null);
    assert.match(problems[0].message, /"9\.x" is not listed/);
  });

  it('says no to a line in development', () => {
    const { target, problems } = resolveTarget(lines, '3.x');

    assert.equal(target, null);
    assert.match(problems[0].message, /in development on devel/);
  });

  it('says no to a line that has ended', () => {
    const { target, problems } = resolveTarget(lines, '0.x');

    assert.equal(target, null);
    assert.match(problems[0].message, /End of Life/);
  });

  it('says no to life support without a label, and names the labels it wants', () => {
    const { target, problems } = resolveTarget(lines, '1.x');

    assert.equal(target, null);
    assert.match(problems[0].message, /security or critical/);
    assert.match(problems[0].message, /--label security or --label critical/);
  });

  it('allows life support with either label', () => {
    for (const label of ['security', 'critical']) {
      const { target, problems } = resolveTarget(lines, '1.x', { label });

      assert.deepEqual(target, {
        version: '1.x',
        stage: 'ls',
        branch: 'ls/v1.x',
      });
      assert.deepEqual(problems, []);
    }
  });

  it('does not let a label open the door to a line that has ended', () => {
    const { target } = resolveTarget(lines, '0.x', { label: 'security' });

    assert.equal(target, null);
  });

  it('does not mind a label on active support', () => {
    const { target, problems } = resolveTarget(lines, '2.x', { label: 'bug' });

    assert.equal(target.version, '2.x');
    assert.deepEqual(problems, []);
  });
});

describe('pull request text', () => {
  it('titles the pull request with the line and the original subject', () => {
    assert.equal(
      pullRequestTitle('1.x', 'fix: correct the flux capacitor'),
      '[v1.x] fix: correct the flux capacitor',
    );
  });

  it('names the original commit and the target line in the body', () => {
    const body = pullRequestBody(
      { version: '1.x', stage: 'as', branch: 'as/v1.x' },
      { sha: 'abc123def456', shortSha: 'abc123d' },
      { branchName: 'backport/1.x/abc123d', remote: 'origin' },
    );

    assert.match(body, /Backport of `abc123d` to the 1\.x line \(as\)\./);
    assert.match(body, /Original commit: `abc123def456`/);
    assert.match(body, /Target branch: `origin\/as\/v1\.x`/);
    assert.match(body, /Backport branch: `backport\/1\.x\/abc123d`/);
  });
});

describe('planBackport', () => {
  const facts = {
    sha: 'abc123def456',
    shortSha: 'abc123d',
    subject: 'fix: correct the flux capacitor',
    version: '1.x',
    stage: 'as',
    branch: 'as/v1.x',
  };

  it('names the branch after the line and the short commit', () => {
    const plan = planBackport(facts);

    assert.equal(plan.branch, 'backport/1.x/abc123d');
    assert.equal(plan.baseRef, 'origin/as/v1.x');
    assert.deepEqual(plan.cherryPick, ['cherry-pick', '-x', 'abc123def456']);
    assert.deepEqual(plan.push, ['push', 'origin', 'backport/1.x/abc123d']);
    assert.deepEqual(plan.labels, []);
    assert.equal(plan.pullRequest, true);
  });

  it('follows the remote it was given', () => {
    const plan = planBackport({ ...facts, remote: 'upstream' });

    assert.equal(plan.baseRef, 'upstream/as/v1.x');
    assert.deepEqual(plan.push, ['push', 'upstream', 'backport/1.x/abc123d']);
  });

  it('lets the branch name, title and label be overridden', () => {
    const plan = planBackport({
      ...facts,
      branchName: 'fix/flux',
      title: 'Fix the flux capacitor',
      label: 'security',
    });

    assert.equal(plan.branch, 'fix/flux');
    assert.equal(plan.title, 'Fix the flux capacitor');
    assert.deepEqual(plan.labels, ['security']);
    // The body has to describe the branch that will really be pushed.
    assert.match(plan.body, /Backport branch: `fix\/flux`/);
  });

  it('carries --no-pr through as pullRequest false', () => {
    const plan = planBackport({ ...facts, pullRequest: false });

    assert.equal(plan.pullRequest, false);
  });
});
