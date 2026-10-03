// Tests for the file and git steps `promote` and `eol` share.
//
// The write path is here rather than in either command, because both commands
// read SUPPORT.yaml, talk to the network and only then write it back. That gap
// is what these tests are about: the file can change while a command is in it.

import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { readSupport, writeMovedLine } from '../src/commands/support-ops.js';
import { loadSupport } from '../src/support-file.js';
import { makeTempDir, supportYaml } from './helpers.js';

/**
 * A directory holding one SUPPORT.yaml, and the lines as they read.
 * @param {import('../src/core/support.js').Line[]} lines
 * @returns {Promise<{cwd: string, expectedLines: import('../src/core/support.js').Line[]}>}
 */
async function setup(lines) {
  const cwd = await makeTempDir({ 'SUPPORT.yaml': supportYaml(lines) });
  const loaded = await loadSupport(cwd);
  assert.equal(loaded.outcome, 'ok');
  return { cwd, expectedLines: loaded.lines };
}

/** The lines SUPPORT.yaml holds right now, without the absent keys. */
async function linesIn(cwd) {
  const loaded = await loadSupport(cwd);
  assert.equal(loaded.outcome, 'ok');
  return loaded.lines.map((line) => {
    const fields = { version: line.version, stage: line.stage };
    if (line.eol) {
      fields.eol = line.eol;
    }
    if (line.components) {
      fields.components = line.components;
    }
    return fields;
  });
}

/** Put different contents on disk, as another writer in the same checkout. */
async function replace(cwd, text) {
  await writeFile(`${cwd}/SUPPORT.yaml`, text, 'utf8');
}

describe('writeMovedLine', () => {
  it('moves the line and leaves the file in Lifeline shape', async () => {
    const { cwd, expectedLines } = await setup([
      { version: '1.x', stage: 'as' },
    ]);

    const move = await writeMovedLine({
      cwd,
      expectedLines,
      version: '1.x',
      stage: 'ls',
      eol: '2027-03-01',
    });

    assert.deepEqual(move.problems, []);
    assert.equal(move.path, `${cwd}/SUPPORT.yaml`);
    assert.deepEqual(await linesIn(cwd), [
      { version: '1.x', stage: 'ls', eol: '2027-03-01' },
    ]);
  });

  it('keeps a transition another writer made to a different line', async () => {
    const { cwd, expectedLines } = await setup([
      { version: '1.x', stage: 'ls', eol: '2027-01-01' },
      { version: '2.x', stage: 'as' },
    ]);
    // The other command ended 1.x while this one was still talking to the
    // remote. Writing this transition from the snapshot would put 1.x back to
    // ls, and backports to it would be allowed again.
    await replace(
      cwd,
      supportYaml([
        { version: '1.x', stage: 'el', eol: '2027-02-01' },
        { version: '2.x', stage: 'as' },
      ]),
    );

    const move = await writeMovedLine({
      cwd,
      expectedLines,
      version: '2.x',
      stage: 'ls',
      eol: '2028-01-01',
    });

    assert.deepEqual(move.problems, []);
    assert.deepEqual(await linesIn(cwd), [
      { version: '1.x', stage: 'el', eol: '2027-02-01' },
      { version: '2.x', stage: 'ls', eol: '2028-01-01' },
    ]);
  });

  it('keeps a line another writer added', async () => {
    const { cwd, expectedLines } = await setup([
      { version: '1.x', stage: 'as' },
    ]);
    await replace(
      cwd,
      supportYaml([
        { version: '1.x', stage: 'as' },
        { version: '2.x', stage: 'indev' },
      ]),
    );

    const move = await writeMovedLine({
      cwd,
      expectedLines,
      version: '1.x',
      stage: 'ls',
      eol: '2027-03-01',
    });

    assert.deepEqual(move.problems, []);
    assert.deepEqual(await linesIn(cwd), [
      { version: '1.x', stage: 'ls', eol: '2027-03-01' },
      { version: '2.x', stage: 'indev' },
    ]);
  });

  it('keeps components another writer changed on the line being moved', async () => {
    const { cwd, expectedLines } = await setup([
      { version: '1.x', stage: 'as' },
    ]);
    // Components are informational, so an edit to them is not a change of
    // policy and must not stop the write.
    await replace(
      cwd,
      'lines:\n  - version: "1.x"\n    stage: as\n    components:\n      - "api"\n',
    );

    const move = await writeMovedLine({
      cwd,
      expectedLines,
      version: '1.x',
      stage: 'ls',
      eol: '2027-03-01',
    });

    assert.deepEqual(move.problems, []);
    assert.deepEqual(await linesIn(cwd), [
      { version: '1.x', stage: 'ls', eol: '2027-03-01', components: ['api'] },
    ]);
  });

  it('writes nothing when the line being moved has already moved', async () => {
    const { cwd, expectedLines } = await setup([
      { version: '1.x', stage: 'as' },
    ]);
    await replace(
      cwd,
      supportYaml([{ version: '1.x', stage: 'el', eol: '2027-02-01' }]),
    );

    const move = await writeMovedLine({
      cwd,
      expectedLines,
      version: '1.x',
      stage: 'ls',
      eol: '2027-03-01',
    });

    assert.equal(move.path, null);
    assert.equal(move.problems.length, 1);
    assert.match(move.problems[0].message, /1\.x is el with eol 2027-02-01/);
    assert.match(
      move.problems[0].message,
      /not 1\.x is as as this command expected/,
    );
    assert.match(move.problems[0].message, /nothing was written/);
    assert.deepEqual(await linesIn(cwd), [
      { version: '1.x', stage: 'el', eol: '2027-02-01' },
    ]);
  });

  it('writes nothing when only the date on the line being moved changed', async () => {
    const { cwd, expectedLines } = await setup([
      { version: '1.x', stage: 'ls', eol: '2027-01-01' },
    ]);
    await replace(
      cwd,
      supportYaml([{ version: '1.x', stage: 'ls', eol: '2028-06-30' }]),
    );

    const move = await writeMovedLine({
      cwd,
      expectedLines,
      version: '1.x',
      stage: 'el',
      eol: '2028-06-30',
    });

    assert.equal(move.path, null);
    assert.match(move.problems[0].message, /eol 2028-06-30/);
    assert.deepEqual(await linesIn(cwd), [
      { version: '1.x', stage: 'ls', eol: '2028-06-30' },
    ]);
  });

  it('writes nothing when the line being moved is gone', async () => {
    const { cwd, expectedLines } = await setup([
      { version: '1.x', stage: 'as' },
      { version: '2.x', stage: 'indev' },
    ]);
    await replace(cwd, supportYaml([{ version: '1.x', stage: 'as' }]));

    const move = await writeMovedLine({
      cwd,
      expectedLines,
      version: '2.x',
      stage: 'as',
    });

    assert.equal(move.path, null);
    assert.match(move.problems[0].message, /2\.x is no longer listed/);
    assert.deepEqual(await linesIn(cwd), [{ version: '1.x', stage: 'as' }]);
  });

  it('writes nothing when the file has gone', async () => {
    const { cwd, expectedLines } = await setup([
      { version: '1.x', stage: 'as' },
    ]);
    await rm(`${cwd}/SUPPORT.yaml`);

    const move = await writeMovedLine({
      cwd,
      expectedLines,
      version: '1.x',
      stage: 'ls',
      eol: '2027-03-01',
    });

    assert.equal(move.path, null);
    assert.match(move.problems[0].message, /No SUPPORT\.yaml/);
  });

  it('writes nothing when the file no longer parses', async () => {
    const { cwd, expectedLines } = await setup([
      { version: '1.x', stage: 'as' },
    ]);
    await replace(cwd, 'lines: [\n');

    const move = await writeMovedLine({
      cwd,
      expectedLines,
      version: '1.x',
      stage: 'ls',
      eol: '2027-03-01',
    });

    assert.equal(move.path, null);
    assert.match(move.problems[0].message, /not valid YAML/);
  });
});

describe('readSupport', () => {
  it('refuses a file with an error in it', async () => {
    const cwd = await makeTempDir({
      'SUPPORT.yaml': 'lines:\n  - version: "1.x"\n    stage: finished\n',
    });

    const support = await readSupport(cwd);

    assert.equal(support.ok, false);
    assert.deepEqual(support.lines, []);
    assert.match(support.problems[0].message, /needs a "stage" of/);
  });

  it('accepts a file whose only problem is a warning', async () => {
    const cwd = await makeTempDir({
      'SUPPORT.yaml':
        'lines:\n  - version: "1.x"\n    stage: as\n    extra: 1\n',
    });

    const support = await readSupport(cwd);

    assert.equal(support.ok, true);
    assert.deepEqual(support.problems, []);
    assert.equal(support.lines.length, 1);
  });
});
