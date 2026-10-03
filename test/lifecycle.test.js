// Tests for src/core/lifecycle.js: the rules about moving a line along, and
// about ending one. Nothing here runs git.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PROMOTE_TARGETS,
  planEol,
  planPromote,
  validateEolFlags,
  validatePromoteFlags,
} from '../src/core/lifecycle.js';

/** A support file to hand to the planners. */
function lines(...entries) {
  return entries.map(([version, stage, extra = {}]) => ({
    version,
    stage,
    ...extra,
  }));
}

describe('validatePromoteFlags', () => {
  it('accepts the two target stages', () => {
    for (const to of PROMOTE_TARGETS) {
      assert.deepEqual(validatePromoteFlags({ to }), []);
    }
  });

  it('rejects a stage that is not a promotion target', () => {
    const problems = validatePromoteFlags({ to: 'el' });

    assert.equal(problems.length, 1);
    assert.match(problems[0].message, /Cannot promote to "el"/);
    assert.match(problems[0].message, /lifeline eol/);
  });

  it('rejects an eol date on the way to Active Support', () => {
    const problems = validatePromoteFlags({ to: 'as', date: '2027-01-01' });

    assert.match(problems[0].message, /--date does not apply to --to as/);
  });

  it('rejects a date that is not a date', () => {
    assert.match(
      validatePromoteFlags({ to: 'ls', date: 'soon' })[0].message,
      /is not a date/,
    );
    assert.match(
      validatePromoteFlags({ to: 'ls', date: '2027-02-30' })[0].message,
      /is not a date/,
    );
  });
});

describe('validateEolFlags', () => {
  it('accepts no date, or a real one', () => {
    assert.deepEqual(validateEolFlags({}), []);
    assert.deepEqual(validateEolFlags({ date: '2027-01-01' }), []);
  });

  it('rejects a date that is not a date', () => {
    assert.match(
      validateEolFlags({ date: '2027-13-01' })[0].message,
      /is not a date/,
    );
  });
});

describe('planPromote indev -> as', () => {
  it('cuts the branch from devel', () => {
    const { plan, problems } = planPromote({
      lines: lines(['3.x', 'indev'], ['2.x', 'as']),
      version: 'v3.x',
    });

    assert.deepEqual(problems, []);
    assert.equal(plan.version, '3.x');
    assert.equal(plan.from, 'indev');
    assert.equal(plan.to, 'as');
    assert.equal(plan.branch, 'as/v3.x');
    assert.equal(plan.baseRef, 'origin/devel');
    assert.deepEqual(plan.push, [
      'push',
      'origin',
      'origin/devel:refs/heads/as/v3.x',
    ]);
    assert.deepEqual(plan.line, {
      version: '3.x',
      stage: 'as',
      eol: undefined,
    });
  });

  it('follows the remote it was given', () => {
    const { plan } = planPromote({
      lines: lines(['3.x', 'indev']),
      version: '3.x',
      remote: 'upstream',
    });

    assert.equal(plan.baseRef, 'upstream/devel');
    assert.deepEqual(plan.push, [
      'push',
      'upstream',
      'upstream/devel:refs/heads/as/v3.x',
    ]);
  });

  it('says no when the line is not listed', () => {
    const { plan, problems } = planPromote({
      lines: lines(['2.x', 'as']),
      version: '9.x',
    });

    assert.equal(plan, null);
    assert.match(problems[0].message, /"9\.x" is not listed/);
  });

  it('says no when the line is already further along', () => {
    const { plan, problems } = planPromote({
      lines: lines(['1.x', 'ls', { eol: '2027-01-01' }]),
      version: '1.x',
    });

    assert.equal(plan, null);
    assert.match(problems[0].message, /already in Life Support/);
  });
});

describe('planPromote as -> ls', () => {
  it('cuts the branch from the line support branch, not devel', () => {
    const { plan, problems } = planPromote({
      lines: lines(['2.x', 'as']),
      version: '2.x',
      to: 'ls',
      date: '2027-03-01',
    });

    assert.deepEqual(problems, []);
    assert.equal(plan.branch, 'ls/v2.x');
    assert.equal(plan.baseRef, 'origin/as/v2.x');
    assert.deepEqual(plan.line, {
      version: '2.x',
      stage: 'ls',
      eol: '2027-03-01',
    });
  });

  it('needs a date when the line has none', () => {
    const { plan, problems } = planPromote({
      lines: lines(['2.x', 'as']),
      version: '2.x',
      to: 'ls',
    });

    assert.equal(plan, null);
    assert.match(problems[0].message, /needs an end-of-life date/);
  });

  it('keeps a date the line already had', () => {
    const { plan } = planPromote({
      lines: lines(['2.x', 'as', { eol: '2026-06-01' }]),
      version: '2.x',
      to: 'ls',
    });

    assert.equal(plan.line.eol, '2026-06-01');
  });

  it('lets a new date replace the old one', () => {
    const { plan } = planPromote({
      lines: lines(['2.x', 'as', { eol: '2026-06-01' }]),
      version: '2.x',
      to: 'ls',
      date: '2028-01-01',
    });

    assert.equal(plan.line.eol, '2028-01-01');
  });
});

describe('planEol', () => {
  it('freezes the line branch and tags the moment', () => {
    const { plan, problems } = planEol({
      lines: lines(['1.x', 'ls', { eol: '2027-01-01' }]),
      version: 'v1.x',
      date: '2027-02-01',
    });

    assert.deepEqual(problems, []);
    assert.equal(plan.from, 'ls');
    assert.equal(plan.to, 'el');
    assert.equal(plan.branch, 'el/v1.x');
    assert.equal(plan.baseRef, 'origin/ls/v1.x');
    assert.equal(plan.tag, 'v1.x-eol');
    assert.deepEqual(plan.push, [
      'push',
      '--atomic',
      'origin',
      'origin/ls/v1.x:refs/heads/el/v1.x',
      'origin/ls/v1.x:refs/tags/v1.x-eol',
    ]);
    assert.deepEqual(plan.line, {
      version: '1.x',
      stage: 'el',
      eol: '2027-02-01',
    });
  });

  it('works for a line still in Active Support', () => {
    const { plan, problems } = planEol({
      lines: lines(['1.x', 'as']),
      version: '1.x',
      date: '2027-02-01',
    });

    assert.deepEqual(problems, []);
    assert.equal(plan.baseRef, 'origin/as/v1.x');
  });

  it('keeps the date the line already had when no date is given', () => {
    const { plan } = planEol({
      lines: lines(['1.x', 'ls', { eol: '2027-01-01' }]),
      version: '1.x',
    });

    assert.equal(plan.line.eol, '2027-01-01');
  });

  it('uses today when there is no date anywhere', () => {
    const { plan } = planEol({ lines: lines(['1.x', 'as']), version: '1.x' });

    assert.match(plan.line.eol, /^\d{4}-\d{2}-\d{2}$/);
  });

  it('says no to a line that has not shipped', () => {
    const { plan, problems } = planEol({
      lines: lines(['3.x', 'indev']),
      version: '3.x',
    });

    assert.equal(plan, null);
    assert.match(problems[0].message, /in development/);
  });

  it('says no to a line that has already ended', () => {
    const { plan, problems } = planEol({
      lines: lines(['0.x', 'el', { eol: '2024-01-01' }]),
      version: '0.x',
    });

    assert.equal(plan, null);
    assert.match(problems[0].message, /already reached End of Life/);
  });

  it('says no to a line that is not listed', () => {
    const { plan, problems } = planEol({
      lines: lines(['1.x', 'ls', { eol: '2027-01-01' }]),
      version: '5.x',
    });

    assert.equal(plan, null);
    assert.match(problems[0].message, /"5\.x" is not listed/);
  });

  it('says no to a line the file lists twice', () => {
    // The first entry says ls and the second says el. Reading the first would
    // plan a freeze for a line that has already ended.
    const { plan, problems } = planEol({
      lines: lines(['1.x', 'ls', { eol: '2027-01-01' }], ['1.x', 'el']),
      version: '1.x',
    });

    assert.equal(plan, null);
    assert.match(problems[0].message, /"1\.x" is listed 2 times/);
  });
});
