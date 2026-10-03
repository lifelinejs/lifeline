// Tests for `lifeline promote`.
//
// Each test builds a real throwaway git repository with a bare "origin", so the
// branch commands really run. Nothing reaches the network.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { promote } from '../src/commands/promote.js';
import { createGit } from '../src/git/git.js';
import { commitFiles, git, makeGitRepo, supportYaml } from './helpers.js';

/**
 * A repository with a remote and one line in development.
 * @param {object} [options]
 * @param {string} [options.support]
 * @param {string[]} [options.branches]
 * @returns {Promise<string>} The repository directory.
 */
async function setup({
  support = supportYaml([{ version: '3.x', stage: 'indev' }]),
  branches = [],
} = {}) {
  const { cwd } = await makeGitRepo({ branches, support, withRemote: true });
  return cwd;
}

/**
 * Run a promotion against a prepared repository.
 * @param {string} cwd
 * @param {object} [overrides]
 * @returns {Promise<import('../src/commands/promote.js').PromoteResult>}
 */
function run(cwd, overrides = {}) {
  return promote({
    cwd,
    git: createGit({ cwd, remote: 'origin' }),
    remote: 'origin',
    version: '3.x',
    ...overrides,
  });
}

/** The refs the remote has, with a space where the tabs are. */
async function remoteRefs(cwd) {
  const output = await git(['ls-remote', 'origin'], cwd);
  return output.replace(/\t/g, ' ');
}

/** Read SUPPORT.yaml back out of the working tree. */
async function readSupportFile(cwd) {
  const { readFile } = await import('node:fs/promises');
  return readFile(`${cwd}/SUPPORT.yaml`, 'utf8');
}

/**
 * The real git for this repository, except that the fetch is where another
 * lifecycle command gets in: `promote` reads SUPPORT.yaml before it fetches,
 * and writes it after, so this is the window the file can change in.
 *
 * @param {string} cwd
 * @param {() => Promise<void>} duringFetch What the other command does.
 * @returns {import('../src/git/git.js').Git}
 */
function gitWithAnotherCommand(cwd, duringFetch) {
  return { ...createGit({ cwd, remote: 'origin' }), fetchRemote: duringFetch };
}

describe('promote indev -> as', () => {
  it('creates the support branch from devel and rewrites SUPPORT.yaml', async () => {
    const cwd = await setup();
    const result = await run(cwd, { write: true });

    assert.equal(result.exitCode, 0);
    assert.equal(result.pushed, true);
    assert.equal(result.branchExisted, false);
    assert.equal(result.written, true);
    assert.deepEqual(result.problems, []);

    const refs = await remoteRefs(cwd);
    assert.match(refs, /refs\/heads\/as\/v3\.x$/m);

    // The new branch points at the same commit as devel.
    const devel = (await git(['rev-parse', 'origin/devel'], cwd)).trim();
    const supportLine = refs
      .split('\n')
      .find((line) => line.includes('refs/heads/as/v3.x'));
    const support = supportLine.split(' ')[0];
    assert.equal(support, devel);

    const text = await readSupportFile(cwd);
    assert.match(text, /version: "3\.x"\n {4}stage: as/);
  });

  it('--dry-run prints a plan and changes nothing', async () => {
    const cwd = await setup();
    const result = await run(cwd, { dryRun: true, write: true });

    assert.equal(result.exitCode, 0);
    assert.equal(result.pushed, false);
    assert.equal(result.written, false);
    assert.match(
      result.steps.join('\n'),
      /Would create as\/v3\.x from origin\/devel/,
    );
    assert.match(
      result.steps.join('\n'),
      /Would set 3\.x to as in SUPPORT\.yaml/,
    );
    assert.doesNotMatch(await remoteRefs(cwd), /as\/v3\.x/);
    assert.doesNotMatch(await readSupportFile(cwd), /stage: as/);
  });

  it('without --write it leaves SUPPORT.yaml and says what to change', async () => {
    const cwd = await setup();
    const before = await readSupportFile(cwd);
    const result = await run(cwd);

    assert.equal(result.exitCode, 0);
    assert.equal(result.written, false);
    assert.equal(await readSupportFile(cwd), before);
    assert.match(result.steps.join('\n'), /Set 3\.x to as in SUPPORT\.yaml/);
  });

  it('keeps the components of the line it moves', async () => {
    const cwd = await setup({
      support:
        'lines:\n' +
        '  - version: "3.x"\n' +
        '    stage: indev\n' +
        '    components:\n' +
        '      - "api: v3"\n' +
        '      - "web"\n',
    });
    await run(cwd, { write: true });

    const text = await readSupportFile(cwd);
    assert.match(text, /stage: as/);
    assert.match(text, /components:/);
    assert.match(text, /- "api: v3"/);
    assert.match(text, /- "web"/);
  });
});

describe('promote as -> ls', () => {
  const support = supportYaml([{ version: '2.x', stage: 'as' }]);

  it('cuts the Life Support branch from the line Active Support branch', async () => {
    const cwd = await setup({ support, branches: ['as/v2.x'] });
    const result = await run(cwd, {
      version: '2.x',
      to: 'ls',
      date: '2027-03-01',
      write: true,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.plan.baseRef, 'origin/as/v2.x');
    assert.match(await remoteRefs(cwd), /refs\/heads\/ls\/v2\.x$/m);

    const as = (await git(['rev-parse', 'origin/as/v2.x'], cwd)).trim();
    const ls = (await git(['rev-parse', 'origin/ls/v2.x'], cwd)).trim();
    assert.equal(ls, as);

    assert.match(await readSupportFile(cwd), /eol: 2027-03-01/);
  });

  it('needs a date and says so', async () => {
    const cwd = await setup({ support, branches: ['as/v2.x'] });
    const result = await run(cwd, { version: '2.x', to: 'ls' });

    assert.equal(result.exitCode, 1);
    assert.match(result.problems[0].message, /needs an end-of-life date/);
    assert.doesNotMatch(await remoteRefs(cwd), /ls\/v2\.x/);
  });
});

describe('promote refusals', () => {
  it('refuses a target stage that is not as or ls', async () => {
    const cwd = await setup();
    const result = await run(cwd, { to: 'el' });

    assert.equal(result.exitCode, 2);
    assert.match(result.problems[0].message, /Cannot promote to "el"/);
  });

  it('refuses a date on the way to Active Support', async () => {
    const cwd = await setup();
    const result = await run(cwd, { to: 'as', date: '2027-01-01' });

    assert.equal(result.exitCode, 2);
    assert.match(result.problems[0].message, /--date does not apply/);
  });

  it('refuses a --date that is not a date', async () => {
    const cwd = await setup();
    const result = await run(cwd, { to: 'ls', date: 'soon' });

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

  it('refuses a line that is already in Life Support', async () => {
    const cwd = await setup({
      support: supportYaml([{ version: '1.x', stage: 'ls' }]),
      branches: ['ls/v1.x'],
    });
    const result = await run(cwd, { version: '1.x' });

    assert.equal(result.exitCode, 1);
    assert.match(result.problems[0].message, /already in Life Support/);
  });

  it('stops on a dirty working tree before pushing', async () => {
    const cwd = await setup();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(`${cwd}/README.md`, 'edited\n', 'utf8');

    const result = await run(cwd);

    assert.equal(result.exitCode, 1);
    assert.match(result.problems[0].message, /uncommitted changes/);
    assert.doesNotMatch(await remoteRefs(cwd), /as\/v3\.x/);
  });

  it('stops when SUPPORT.yaml is missing', async () => {
    const { cwd } = await makeGitRepo({ withRemote: true });
    const result = await run(cwd);

    assert.equal(result.exitCode, 2);
    assert.match(result.problems[0].message, /SUPPORT\.yaml/);
  });

  it('refuses an existing branch, unless --force', async () => {
    const cwd = await setup({ branches: ['as/v3.x'] });
    const refused = await run(cwd);

    assert.equal(refused.exitCode, 1);
    assert.match(refused.problems[0].message, /already exists/);
    assert.match(refused.problems[0].message, /--force/);

    const forced = await run(cwd, { force: true, write: true });

    assert.equal(forced.exitCode, 0);
    assert.equal(forced.branchExisted, true);
    assert.equal(forced.pushed, false);
    assert.match(await readSupportFile(cwd), /stage: as/);
  });

  it('refuses a branch that exists only on the remote', async () => {
    const cwd = await setup();
    // Somebody else created as/v3.x on the remote; this checkout never saw it.
    await git(['branch', 'as/v3.x'], cwd);
    await git(['push', 'origin', 'as/v3.x'], cwd);
    await git(['branch', '-D', 'as/v3.x'], cwd);

    const result = await run(cwd);

    assert.equal(result.exitCode, 1);
    assert.match(result.problems[0].message, /as\/v3\.x already exists/);
    assert.match(result.problems[0].message, /--force/);
  });

  it('pushes the branch even when only this checkout has one', async () => {
    const cwd = await setup();
    await git(['branch', 'as/v3.x'], cwd); // local only: the remote has none

    const result = await run(cwd, { force: true, write: true });

    assert.equal(result.exitCode, 0, JSON.stringify(result.problems));
    assert.equal(result.pushed, true);
    assert.match(await remoteRefs(cwd), /refs\/heads\/as\/v3\.x$/m);
    assert.match(await readSupportFile(cwd), /stage: as/);
  });
});

describe('promote when SUPPORT.yaml is behind the remote', () => {
  it('refuses a line the remote has already ended', async () => {
    // The freeze was pushed and the file write was lost, so the file still
    // calls the line a line in development. Promoting on the file's word alone
    // would hand a line that has ended a new Active Support branch.
    const cwd = await setup();
    await git(['branch', 'el/v3.x'], cwd);
    await git(['push', 'origin', 'el/v3.x'], cwd);

    const result = await run(cwd, { write: true });

    assert.equal(result.exitCode, 1);
    assert.equal(result.pushed, false);
    assert.equal(result.written, false);
    assert.match(
      result.problems[0].message,
      /origin\/el\/v3\.x exists, but SUPPORT\.yaml still says 3\.x is indev/,
    );
    assert.match(result.problems[0].message, /no branch was created/);

    // Nothing was created and the file is left as it was found.
    assert.doesNotMatch(await remoteRefs(cwd), /refs\/heads\/as\/v3\.x$/m);
    assert.match(await readSupportFile(cwd), /stage: indev/);
  });

  it('refuses to graduate a line the remote has already ended', async () => {
    // The same drift from Active Support: ls/v3.x would be cut from as/v3.x
    // for a line the remote froze.
    const cwd = await setup({
      support: supportYaml([
        { version: '3.x', stage: 'as', eol: '2030-01-01' },
      ]),
      branches: ['as/v3.x'],
    });
    await git(['branch', 'el/v3.x', 'as/v3.x'], cwd);
    await git(['push', 'origin', 'el/v3.x'], cwd);

    const result = await run(cwd, {
      to: 'ls',
      date: '2030-01-01',
      write: true,
    });

    assert.equal(result.exitCode, 1);
    assert.equal(result.pushed, false);
    assert.match(result.problems[0].message, /origin\/el\/v3\.x exists/);
    assert.doesNotMatch(await remoteRefs(cwd), /refs\/heads\/ls\/v3\.x$/m);
    assert.match(await readSupportFile(cwd), /stage: as/);
  });

  it('refuses the same way with --force, which is for this branch only', async () => {
    const cwd = await setup();
    await git(['branch', 'el/v3.x'], cwd);
    await git(['push', 'origin', 'el/v3.x'], cwd);

    const result = await run(cwd, { force: true, write: true });

    assert.equal(result.exitCode, 1);
    assert.equal(result.pushed, false);
    assert.doesNotMatch(await remoteRefs(cwd), /refs\/heads\/as\/v3\.x$/m);
  });

  it('ignores a branch that exists only in this checkout', async () => {
    const cwd = await setup();
    await git(['branch', 'ls/v3.x'], cwd); // local only: the remote has none

    const result = await run(cwd, { write: true });

    assert.equal(result.exitCode, 0, JSON.stringify(result.problems));
    assert.equal(result.pushed, true);
    assert.match(await readSupportFile(cwd), /stage: as/);
  });
});

describe('promote alongside another lifecycle command', () => {
  const twoLines = supportYaml([
    { version: '1.x', stage: 'ls', eol: '2027-01-01' },
    { version: '3.x', stage: 'indev' },
  ]);

  it('does not put another line back where it was', async () => {
    const cwd = await setup({ support: twoLines, branches: ['ls/v1.x'] });

    const result = await run(cwd, {
      write: true,
      // Another command ends 1.x and commits it, all while this promotion is
      // fetching. Rendering the file from the snapshot taken before the fetch
      // would set 1.x back to ls, and backports to an ended line would be
      // allowed again.
      git: gitWithAnotherCommand(cwd, () =>
        commitFiles(
          cwd,
          {
            'SUPPORT.yaml':
              '# yaml-language-server: $schema=example\n' +
              'lines:\n' +
              '  - version: "1.x"\n' +
              '    stage: el\n' +
              '    eol: 2027-02-01\n' +
              '  - version: "3.x"\n' +
              '    stage: indev\n',
          },
          'chore: end 1.x',
        ),
      ),
    });

    assert.equal(result.exitCode, 0, JSON.stringify(result.problems));
    assert.equal(result.written, true);

    const text = await readSupportFile(cwd);
    assert.match(text, /version: "1\.x"\n {4}stage: el\n {4}eol: 2027-02-01/);
    assert.match(text, /version: "3\.x"\n {4}stage: as/);
  });

  it('writes nothing when the line it is promoting has moved on', async () => {
    const cwd = await setup({ support: twoLines, branches: ['ls/v1.x'] });

    const result = await run(cwd, {
      write: true,
      // Somebody moves 3.x on by hand and commits, mid-run.
      git: gitWithAnotherCommand(cwd, () =>
        commitFiles(
          cwd,
          {
            'SUPPORT.yaml':
              '# a note Lifeline would not write\n' +
              'lines:\n' +
              '  - version: "1.x"\n' +
              '    stage: ls\n' +
              '    eol: 2027-01-01\n' +
              '  - version: "3.x"\n' +
              '    stage: ls\n' +
              '    eol: 2028-01-01\n',
          },
          'chore: 3.x is further along',
        ),
      ),
    });

    // The branch is pushed, because that half of the promotion is still right;
    // the file is left for the user to look at.
    assert.equal(result.exitCode, 1);
    assert.equal(result.pushed, true);
    assert.equal(result.written, false);
    assert.equal(result.path, null);
    assert.match(result.problems[0].message, /3\.x is ls with eol 2028-01-01/);
    assert.match(result.problems[0].message, /nothing was written/);
    assert.match(result.steps.join('\n'), /Set 3\.x to as in SUPPORT\.yaml/);

    // Untouched: the note Lifeline would have dropped is still there.
    const text = await readSupportFile(cwd);
    assert.match(text, /# a note Lifeline would not write/);
    assert.match(text, /eol: 2028-01-01/);
  });
});
