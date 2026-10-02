// Tests for src/core/dates.js. Every test passes "today" in, so the answers do
// not change from one day to the next.

import test from 'node:test';
import assert from 'node:assert/strict';

import { daysUntilEol } from '../src/core/dates.js';

const NOW = new Date('2026-01-15T23:59:00Z');

test('counts whole days to a future date', () => {
  assert.equal(daysUntilEol('2026-01-25', NOW), 10);
  assert.equal(daysUntilEol('2026-01-16', NOW), 1);
  assert.equal(daysUntilEol('2026-01-15', NOW), 0);
});

test('a date in the past gives a negative count', () => {
  assert.equal(daysUntilEol('2025-12-31', NOW), -15);
});

test('crossing months and years works', () => {
  assert.equal(
    daysUntilEol('2027-03-01', new Date('2026-12-31T00:00:00Z')),
    60,
  );
  assert.equal(daysUntilEol('2028-02-29', new Date('2028-02-28T00:00:00Z')), 1);
});

test('the answer does not depend on the time of day', () => {
  assert.equal(daysUntilEol('2026-01-16', new Date('2026-01-15T00:00:01Z')), 1);
  assert.equal(daysUntilEol('2026-01-16', new Date('2026-01-15T23:59:59Z')), 1);
});

test('no date, or an unreadable date, gives null', () => {
  assert.equal(daysUntilEol(null, NOW), null);
  assert.equal(daysUntilEol(undefined, NOW), null);
  assert.equal(daysUntilEol('next spring', NOW), null);
});
