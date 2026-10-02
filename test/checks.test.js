// Tests for src/core/checks.js: the rules about lines and each other.

import test from 'node:test';
import assert from 'node:assert/strict';

import { checkLines } from '../src/core/checks.js';

/** Build a line without repeating stage/version names everywhere. */
function line(version, stage, extra = {}) {
  return { version, stage, ...extra };
}

/** Only the error-level problems, as an array of strings. */
function errors(lines) {
  return checkLines(lines)
    .filter((problem) => problem.level === 'error')
    .map((problem) => problem.message);
}

/** Only the warning-level problems, as an array of strings. */
function warnings(lines) {
  return checkLines(lines)
    .filter((problem) => problem.level === 'warning')
    .map((problem) => problem.message);
}

test('a healthy support file has no problems', () => {
  const lines = [
    line('3.x', 'indev'),
    line('2.x', 'as'),
    line('1.x', 'ls', { eol: '2030-01-01' }),
    line('0.x', 'el'),
  ];
  assert.deepEqual(checkLines(lines), []);
});

test('error: the same version twice', () => {
  const problems = errors([
    line('1.x', 'as'),
    line('1.x', 'ls', { eol: '2030-01-01' }),
  ]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /"1\.x" is listed 2 times/);
});

test('error: more than one indev line', () => {
  const problems = errors([line('3.x', 'indev'), line('2.x', 'indev')]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /2 lines are at stage indev/);
});

test('error: a newer line is further along than an older one', () => {
  // 3.x (newer) in ls while 2.x (older) is only in as: impossible, because
  // support only ever moves forward as versions get older.
  const problems = errors([
    line('3.x', 'ls', { eol: '2030-01-01' }),
    line('2.x', 'as'),
  ]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /"3\.x" is ls but older line "2\.x" is as/);
});

test('error: a newer line is in el while an older one is in indev', () => {
  const problems = errors([line('2.x', 'el'), line('1.x', 'indev')]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /"2\.x" is el but older line "1\.x" is indev/);
});

test('stage ordering accepts equal and forward stages', () => {
  assert.deepEqual(errors([line('3.x', 'as'), line('2.x', 'as')]), []);
  assert.deepEqual(
    errors([line('3.x', 'as'), line('2.x', 'ls', { eol: '2030-01-01' })]),
    [],
  );
  assert.deepEqual(errors([line('3.x', 'indev'), line('2.x', 'el')]), []);
});

test('stage ordering skips lines with a stage it does not know', () => {
  // parseSupport already complained about "beta"; ordering must not crash.
  assert.deepEqual(errors([line('3.x', 'ls'), line('2.x', 'beta')]), []);
});

test('warning: more than one as line', () => {
  const problems = warnings([
    line('3.x', 'as'),
    line('2.x', 'as'),
    line('1.x', 'ls', { eol: '2030-01-01' }),
  ]);
  assert.deepEqual(problems.length, 1);
  assert.match(problems[0], /2 lines are at stage as/);
});

test('warning: more than two ls lines', () => {
  const lines = [
    line('4.x', 'as'),
    line('3.x', 'ls', { eol: '2030-01-01' }),
    line('2.x', 'ls', { eol: '2031-01-01' }),
    line('1.x', 'ls', { eol: '2032-01-01' }),
  ];
  const problems = warnings(lines);
  assert.deepEqual(problems.length, 1);
  assert.match(problems[0], /3 lines are at stage ls/);
});

test('two ls lines are fine', () => {
  const lines = [
    line('3.x', 'as'),
    line('2.x', 'ls', { eol: '2030-01-01' }),
    line('1.x', 'ls', { eol: '2031-01-01' }),
  ];
  assert.deepEqual(warnings(lines), []);
});

test('warning: an ls line without an eol date', () => {
  const problems = warnings([line('2.x', 'as'), line('1.x', 'ls')]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /"1\.x" is in Life Support but has no "eol" date/);
});

test('warning: an eol date on a line that is not ls', () => {
  assert.match(
    warnings([line('1.x', 'as', { eol: '2030-01-01' })])[0],
    /has an "eol" date but is as/,
  );
  assert.match(
    warnings([line('0.x', 'el', { eol: '2024-01-01' })])[0],
    /has an "eol" date but is el/,
  );
});

test('errors come before warnings in the returned list', () => {
  const lines = [line('3.x', 'indev'), line('2.x', 'indev'), line('1.x', 'ls')];
  const problems = checkLines(lines);
  const firstWarning = problems.findIndex(
    (problem) => problem.level === 'warning',
  );
  const lastError = problems
    .map((problem) => problem.level)
    .lastIndexOf('error');

  assert.ok(
    lastError < firstWarning,
    'every error should be listed before any warning',
  );
});
