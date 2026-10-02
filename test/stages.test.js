// Tests for the stage/branch vocabulary in src/core/stages.js.
// `node:test` is Node's built-in test runner; `node:assert/strict` is its
// assertion library. Run them all with `npm test`.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STAGES,
  branchFor,
  isSupportBranch,
  lineFromBranch,
  majorOf,
  sortLinesNewestFirst,
  stageIndex,
  SUPPORT_BRANCH_PATTERN,
} from '../src/core/stages.js';

test('STAGES lists the lifecycle from newest to oldest', () => {
  assert.deepEqual(STAGES, ['indev', 'as', 'ls', 'el']);
});

test('majorOf reads the major number out of a version', () => {
  assert.equal(majorOf('0.x'), 0);
  assert.equal(majorOf('12.x'), 12);
  assert.equal(majorOf('2'), null);
  assert.equal(majorOf('v2.x'), null);
});

test('stageIndex numbers the stages in lifecycle order', () => {
  assert.equal(stageIndex('indev'), 0);
  assert.equal(stageIndex('el'), 3);
  assert.equal(stageIndex('nope'), -1);
});

test('branchFor sends indev to devel and every other stage to its branch', () => {
  assert.equal(branchFor({ version: '3.x', stage: 'indev' }), 'devel');
  assert.equal(branchFor({ version: '2.x', stage: 'as' }), 'as/v2.x');
  assert.equal(branchFor({ version: '1.x', stage: 'ls' }), 'ls/v1.x');
  assert.equal(branchFor({ version: '0.x', stage: 'el' }), 'el/v0.x');
});

test('branchFor returns null for a stage it does not know', () => {
  assert.equal(branchFor({ version: '2.x', stage: 'beta' }), null);
});

test('isSupportBranch matches only as|ls|el over vN.x', () => {
  assert.equal(SUPPORT_BRANCH_PATTERN.source, '^(as|ls|el)\\/v\\d+\\.x$');
  assert.equal(isSupportBranch('as/v2.x'), true);
  assert.equal(isSupportBranch('ls/v1.x'), true);
  assert.equal(isSupportBranch('el/v0.x'), true);
  assert.equal(isSupportBranch('devel'), false);
  assert.equal(isSupportBranch('as/v2.1'), false);
  // Backport branches are temporary and are NOT support branches.
  assert.equal(isSupportBranch('backport/v1.x/abc1234'), false);
  assert.equal(isSupportBranch('feature/cool-thing'), false);
});

test('lineFromBranch turns a support branch into a line', () => {
  assert.deepEqual(lineFromBranch('as/v2.x'), { version: '2.x', stage: 'as' });
  assert.equal(lineFromBranch('devel'), null);
  assert.equal(lineFromBranch('backport/v1.x/abc1234'), null);
});

test('sortLinesNewestFirst orders 3.x before 2.x before 1.x', () => {
  const sorted = sortLinesNewestFirst([
    { version: '1.x' },
    { version: '3.x' },
    { version: '0.x' },
    { version: '2.x' },
  ]);
  assert.deepEqual(
    sorted.map((line) => line.version),
    ['3.x', '2.x', '1.x', '0.x'],
  );
});
