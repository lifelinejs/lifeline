// Tests for the status command: reading SUPPORT.yaml into rows, and the table
// that cli.js prints from those rows.

import test from 'node:test';
import assert from 'node:assert/strict';

import { readStatus } from '../src/commands/status.js';
import { formatStatusTable } from '../src/cli.js';
import { makeTempDir, supportYaml } from './helpers.js';

/** A fixed "today" so day counts never depend on when the test runs. */
const NOW = new Date('2026-01-15T09:30:00Z');

test('reads one row per line, newest line first', async () => {
  const cwd = await makeTempDir({
    'SUPPORT.yaml': supportYaml([
      { version: '1.x', stage: 'ls', eol: '2027-03-01' },
      { version: '3.x', stage: 'indev' },
      { version: '2.x', stage: 'as' },
    ]),
  });

  const status = await readStatus({ cwd, now: NOW });

  assert.deepEqual(status.problems, []);
  assert.deepEqual(
    status.rows.map((row) => row.version),
    ['3.x', '2.x', '1.x'],
  );
});

test('fills in the branch each line should have', async () => {
  const cwd = await makeTempDir({
    'SUPPORT.yaml': supportYaml([
      { version: '2.x', stage: 'as' },
      { version: '1.x', stage: 'ls', eol: '2027-03-01' },
      { version: '0.x', stage: 'el' },
    ]),
  });

  const status = await readStatus({ cwd, now: NOW });

  assert.deepEqual(
    status.rows.map((row) => row.branch),
    ['as/v2.x', 'ls/v1.x', 'el/v0.x'],
  );
});

test('counts the days until eol, and leaves "-" when there is none', async () => {
  const cwd = await makeTempDir({
    'SUPPORT.yaml': supportYaml([
      { version: '2.x', stage: 'as' },
      { version: '1.x', stage: 'ls', eol: '2026-01-25' },
    ]),
  });

  const status = await readStatus({ cwd, now: NOW });

  assert.equal(status.rows[0].daysUntilEol, null);
  assert.equal(status.rows[0].eol, null);
  assert.equal(status.rows[1].eol, '2026-01-25');
  assert.equal(status.rows[1].daysUntilEol, 10);
});

test('an eol in the past gives a negative day count', async () => {
  const cwd = await makeTempDir({
    'SUPPORT.yaml': supportYaml([
      { version: '1.x', stage: 'ls', eol: '2025-12-31' },
    ]),
  });

  const status = await readStatus({ cwd, now: NOW });

  assert.equal(status.rows[0].daysUntilEol, -15);
});

test('a missing SUPPORT.yaml is reported, not thrown', async () => {
  const cwd = await makeTempDir();

  const status = await readStatus({ cwd, now: NOW });

  assert.equal(status.outcome, 'missing');
  assert.deepEqual(status.rows, []);
  assert.match(status.problems[0].message, /No SUPPORT\.yaml/);
  assert.equal(status.problems[0].level, 'error');
});

test('a broken SUPPORT.yaml keeps its problems', async () => {
  const cwd = await makeTempDir({
    'SUPPORT.yaml': 'lines:\n  - version: "2.1"\n    stage: as\n',
  });

  const status = await readStatus({ cwd, now: NOW });

  assert.equal(status.outcome, 'ok');
  assert.deepEqual(status.rows, []);
  assert.match(status.problems[0].message, /needs a "version" string/);
});

test('the table lines every column up', () => {
  const table = formatStatusTable([
    {
      version: '3.x',
      stage: 'indev',
      branch: 'devel',
      eol: null,
      daysUntilEol: null,
    },
    {
      version: '1.x',
      stage: 'ls',
      branch: 'ls/v1.x',
      eol: '2027-03-01',
      daysUntilEol: 410,
    },
  ]);
  const lines = table.split('\n');

  assert.equal(lines.length, 3);
  assert.match(
    lines[0],
    /^VERSION {2}STAGE {2}BRANCH {3}EXISTS {2}EOL {9}DAYS TO EOL$/,
  );

  // Where each of the first four columns starts, taken from the spaces.
  const columnStarts = lines.map((line) =>
    [...line.matchAll(/\S+/g)].slice(0, 4).map((word) => word.index),
  );
  assert.deepEqual(columnStarts[1], columnStarts[0]);
  assert.deepEqual(columnStarts[2], columnStarts[0]);

  // The values really are in the table.
  assert.ok(table.includes('2027-03-01'));
  assert.ok(table.endsWith('410'));
});

test('the table uses "-" for empty cells and right-aligns the day count', () => {
  const table = formatStatusTable([
    {
      version: '2.x',
      stage: 'as',
      branch: null,
      exists: false,
      eol: null,
      daysUntilEol: 7,
    },
  ]);

  assert.equal(
    table.split('\n')[1],
    '2.x      as     -       no      -              7',
  );
});

test('the exists column says yes, no, or "?" when git could not answer', () => {
  const row = {
    version: '1.x',
    stage: 'ls',
    branch: 'ls/v1.x',
    eol: null,
    daysUntilEol: null,
  };
  const yes = formatStatusTable([{ ...row, exists: true }]).split('\n')[1];
  const unknown = formatStatusTable([{ ...row, exists: null }]).split('\n')[1];

  assert.match(yes, /ls\/v1\.x {2}yes/);
  assert.match(unknown, /ls\/v1\.x {2}\?/);
});

test('the table works with no lines at all', () => {
  assert.equal(
    formatStatusTable([]),
    'VERSION  STAGE  BRANCH  EXISTS  EOL  DAYS TO EOL',
  );
});
