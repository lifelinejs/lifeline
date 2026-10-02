// Tests for `lifeline eol`.
//
// Each test builds a real throwaway git repository with a bare "origin", so the
// branch and tag commands really run. Nothing reaches the network.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { eol } from '../src/commands/eol.js';
import { createGit } from '../src/git/git.js';
import { git, makeGitRepo, supportYaml } from './helpers.js';

/**
 * A repository with a remote and a line that can end.
 * @param {object} [options]
 * @param {string} [options.support]
 * @param {string[]} [options.branches]
 * @returns {Promise<string>} The repository directory.
 */
async function setup({
  support = supportYaml([{ version: '1.x', stage: 'ls', eol: '2027-01-01' }]),
  branches = ['ls/v1.x'],
  tags = [],
} = {}) {
  const { cwd } = await makeGitRepo({
    branches,
    tags,
    support,
    withRemote: true,
  });
  return cwd;
}

/**
 * Run `eol` against a prepared repository.
 * @param {string} cwd
 * @param {object} [overrides]
 * @returns {Promise<import('../src/commands/eol.js').EolResult>}
 */
function run(cwd, overrides = {}) {
  return eol({
    cwd,
    git: createGit({ cwd, remote: 'origin' }),
    remote: 'origin',
    version: '1.x',
    ...overrides,
  });
}

/** The remote's refs, tabs turned into spaces. */
async function remoteRefs(cwd) {
  const output = await git(['ls-remote', 'origin'], cwd);
  return output.replace(/\t/g, ' ');
}

/** Read SUPPORT.yaml back out of the working tree. */
async function readSupportFile(cwd) {
  const { readFile } = await import('node:fs/promises');
  return readFile(`${cwd}/SUPPORT.yaml`, 'utf8');
}

/** Today in UTC, as the command writes it. */
function today() {
  return new Date().toISOString().slice(0, 10);
}

describe('eol happy path', () => {
  it('freezes the line, tags it, and rewrites SUPPORT.yaml', async () => {
    const cwd = await setup();
    const before = (await git(['rev-parse', 'origin/ls/v1.x'], cwd)).trim();
    const result = await run(cwd, { date: '2027-02-01', write: true });

    assert.equal(result.exitCode, 0);
    assert.equal(result.pushed, true);
    assert.equal(result.written, true);
    assert.deepEqual(result.problems, []);

    const refs = await remoteRefs(cwd);
    // Both refs point at the commit the line was on.
    const branchLine = refs
      .split('\n')
      .find((line) => line.includes('refs/heads/el/v1.x'));
    const tagLine = refs
      .split('\n')
      .find((line) => line.includes('refs/tags/v1.x-eol'));
    assert.ok(branchLine, 'el/v1.x should exist on the remote');
    assert.ok(tagLine, 'v1.x-eol should exist on the remote');
    assert.equal(branchLine.split(' ')[0], before);
    assert.equal(tagLine.split(' ')[0], before);

    const text = await readSupportFile(cwd);
    assert.match(text, /stage: el/);
    assert.match(text, /eol: 2027-02-01/);
  });

  it('defaults the date to today when the line has none', async () => {
    const cwd = await setup({
      support: supportYaml([{ version: '1.x', stage: 'as' }]),
      branches: ['as/v1.x'],
    });
    const result = await run(cwd, { write: true });

    assert.equal(result.exitCode, 0);
    assert.equal(result.plan.line.eol, today());
    assert.match(await readSupportFile(cwd), new RegExp(`eol: ${today()}`));
  });

  it('keeps the date the line already had when none is given', async () => {
    const cwd = await setup();
    const result = await run(cwd, { write: true });

    assert.equal(result.plan.line.eol, '2027-01-01');
  });

  it('works for a line still in Active Support', async () => {
    const cwd = await setup({
      support: supportYaml([{ version: '1.x', stage: 'as' }]),
      branches: ['as/v1.x'],
    });
    const result = await run(cwd, { date: '2027-02-01' });

    assert.equal(result.exitCode, 0);
    assert.match(await remoteRefs(cwd), /refs\/heads\/el\/v1\.x$/m);
  });

  it('--dry-run prints a plan and changes nothing', async () => {
    const cwd = await setup();
    const before = await readSupportFile(cwd);
    const result = await run(cwd, {
      date: '2027-02-01',
      dryRun: true,
      write: true,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.pushed, false);
    assert.equal(result.written, false);
    assert.match(
      result.steps.join('\n'),
      /Would create el\/v1\.x from origin\/ls\/v1\.x/,
    );
    assert.match(
      result.steps.join('\n'),
      /Would tag origin\/ls\/v1\.x as v1\.x-eol/,
    );

    const refs = await remoteRefs(cwd);
    assert.doesNotMatch(refs, /refs\/heads\/el\//);
    assert.doesNotMatch(refs, /v1\.x-eol/);
    assert.equal(await readSupportFile(cwd), before);
  });

  it('keeps the components of the line it ends', async () => {
    const cwd = await setup({
      support:
        'lines:\n' +
        '  - version: "1.x"\n' +
        '    stage: ls\n' +
        '    eol: 2027-01-01\n' +
        '    components:\n' +
        '      - "api: v1"\n',
    });
    await run(cwd, { write: true });

    const text = await readSupportFile(cwd);
    assert.match(text, /stage: el/);
    assert.match(text, /- "api: v1"/);
  });
});

describe('eol refusals', () => {
  it('refuses a line in development', async () => {
    const cwd = await setup({
      support: supportYaml([{ version: '3.x', stage: 'indev' }]),
      branches: [],
    });
    const result = await run(cwd, { version: '3.x' });

    assert.equal(result.exitCode, 1);
    assert.match(result.problems[0].message, /in development/);
  });

  it('refuses a line that has already ended', async () => {
    const cwd = await setup({
      support: supportYaml([
        { version: '0.x', stage: 'el', eol: '2024-01-01' },
      ]),
      branches: ['el/v0.x'],
    });
    const result = await run(cwd, { version: '0.x' });

    assert.equal(result.exitCode, 1);
    assert.match(result.problems[0].message, /already reached End of Life/);
  });

  it('refuses a --date that is not a date', async () => {
    const cwd = await setup();
    const result = await run(cwd, { date: '2027-02-30' });

    assert.equal(result.exitCode, 2);
    assert.match(result.problems[0].message, /is not a date/);
  });

  it('refuses something that is not a line', async () => {
    const cwd = await setup();
    const result = await run(cwd, { version: 'banana' });

    assert.equal(result.exitCode, 2);
    assert.match(result.problems[0].message, /is not a line/);
  });

  it('refuses a line that is not listed', async () => {
    const cwd = await setup();
    const result = await run(cwd, { version: '9.x' });

    assert.equal(result.exitCode, 1);
    assert.match(result.problems[0].message, /"9\.x" is not listed/);
  });

  it('stops on a dirty working tree before pushing', async () => {
    const cwd = await setup();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(`${cwd}/README.md`, 'edited\n', 'utf8');

    const result = await run(cwd, { date: '2027-02-01' });

    assert.equal(result.exitCode, 1);
    assert.match(result.problems[0].message, /uncommitted changes/);
    assert.doesNotMatch(await remoteRefs(cwd), /refs\/heads\/el\//);
  });

  it('stops when the line has no branch to freeze', async () => {
    const cwd = await setup({
      support: supportYaml([
        { version: '1.x', stage: 'ls', eol: '2027-01-01' },
      ]),
      branches: [],
    });
    const result = await run(cwd, { date: '2027-02-01' });

    assert.equal(result.exitCode, 1);
    assert.match(
      result.problems[0].message,
      /origin\/ls\/v1\.x does not exist/,
    );
  });
});

describe('eol with refs that already exist', () => {
  it('refuses an existing el branch, unless --force', async () => {
    const cwd = await setup({ branches: ['ls/v1.x', 'el/v1.x'] });
    const refused = await run(cwd, { date: '2027-02-01' });

    assert.equal(refused.exitCode, 1);
    assert.match(refused.problems[0].message, /already exists?/);
    assert.match(refused.problems[0].message, /--force/);

    const forced = await run(cwd, {
      date: '2027-02-01',
      force: true,
      write: true,
    });

    assert.equal(forced.exitCode, 0);
    assert.equal(forced.branchExisted, true);
    // The branch was accepted as it is; only the missing tag was made.
    assert.match(await remoteRefs(cwd), /refs\/tags\/v1\.x-eol$/m);
    assert.match(await readSupportFile(cwd), /stage: el/);
  });

  it('refuses an existing tag, unless --force', async () => {
    const cwd = await setup({ tags: ['v1.x-eol'] });
    const refused = await run(cwd, { date: '2027-02-01' });

    assert.equal(refused.exitCode, 1);
    assert.match(refused.problems[0].message, /v1\.x-eol already exists/);
  });

  it('with --force and both refs there, it only rewrites the file', async () => {
    const cwd = await setup({
      tags: ['v1.x-eol'],
      branches: ['ls/v1.x', 'el/v1.x'],
    });
    const result = await run(cwd, {
      date: '2027-02-01',
      force: true,
      write: true,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.pushed, false);
    assert.equal(result.branchExisted, true);
    assert.equal(result.tagExisted, true);
    assert.match(await readSupportFile(cwd), /stage: el/);
  });
});
