// Tests for `lifeline eol`.
//
// Each test builds a real throwaway git repository with a bare "origin", so the
// branch and tag commands really run. Nothing reaches the network.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { eol } from '../src/commands/eol.js';
import { createGit } from '../src/git/git.js';
import { git, commitFiles, makeGitRepo, supportYaml } from './helpers.js';

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
  if (tags.length > 0) {
    // The tag check asks the remote, so a tag the test wants to count as
    // "already there" has to be there, not only in this checkout.
    await git(['push', 'origin', '--tags'], cwd);
  }
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

/**
 * The real git for this repository, except that the fetch is where another
 * lifecycle command gets in: `eol` reads SUPPORT.yaml before it fetches, and
 * writes it after, so this is the window the file can change in.
 *
 * @param {string} cwd
 * @param {() => Promise<void>} duringFetch What the other command does.
 * @returns {import('../src/git/git.js').Git}
 */
function gitWithAnotherCommand(cwd, duringFetch) {
  return { ...createGit({ cwd, remote: 'origin' }), fetchRemote: duringFetch };
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
  for (const force of [false, true]) {
    it(`stops before pushing or writing when the remote tag lookup fails with force=${force}`, async () => {
      const cwd = await setup({
        branches: force ? ['ls/v1.x', 'el/v1.x'] : ['ls/v1.x'],
      });
      const before = await readSupportFile(cwd);
      const refsBefore = await remoteRefs(cwd);
      const realGit = createGit({ cwd });
      const calls = [];
      const result = await run(cwd, {
        force,
        write: true,
        git: {
          ...realGit,
          run: async (args) => {
            calls.push(args);
            // Only the tag lookup fails - the scenario this test is about;
            // the branch lookup still answers.
            if (args[0] === 'ls-remote' && args.includes('--tags')) {
              throw Object.assign(new Error('Command failed'), {
                stderr: 'remote lookup unavailable\n',
              });
            }
            return realGit.run(args);
          },
        },
      });

      assert.equal(result.exitCode, 1);
      assert.deepEqual(result.problems, [
        {
          level: 'error',
          message:
            'git ls-remote --tags origin refs/tags/v1.x-eol failed: remote lookup unavailable',
        },
      ]);
      assert.equal(result.branchExisted, force);
      assert.equal(result.pushed, false);
      assert.equal(result.written, false);
      assert.equal(
        calls.some((args) => args[0] === 'push'),
        false,
      );
      assert.equal(await remoteRefs(cwd), refsBefore);
      assert.equal(await readSupportFile(cwd), before);
    });
  }

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

  it('refuses an el branch that exists only on the remote', async () => {
    const cwd = await setup();
    // The freeze branch was pushed by someone else; this checkout never saw it.
    await git(['branch', 'el/v1.x'], cwd);
    await git(['push', 'origin', 'el/v1.x'], cwd);
    await git(['branch', '-D', 'el/v1.x'], cwd);

    const result = await run(cwd, { date: '2027-02-01' });

    assert.equal(result.exitCode, 1);
    assert.match(result.problems[0].message, /el\/v1\.x already exists/);
    assert.match(result.problems[0].message, /--force/);
  });

  it('freezes on the remote even when only this checkout has the branch', async () => {
    const cwd = await setup();
    await git(['branch', 'el/v1.x'], cwd); // local only: the remote has none

    const result = await run(cwd, { date: '2027-02-01', force: true });

    assert.equal(result.exitCode, 0, JSON.stringify(result.problems));
    assert.equal(result.branchExisted, false);
    assert.match(await remoteRefs(cwd), /refs\/heads\/el\/v1\.x$/m);
    assert.match(await remoteRefs(cwd), /refs\/tags\/v1\.x-eol$/m);
  });

  it('ignores a tag that exists only in this checkout', async () => {
    const cwd = await setup();
    await git(['tag', 'v1.x-eol'], cwd); // local only: origin does not have it

    const result = await run(cwd, { date: '2027-02-01' });

    assert.equal(result.exitCode, 0, JSON.stringify(result.problems));
    assert.equal(result.tagExisted, false);
    assert.match(await remoteRefs(cwd), /refs\/tags\/v1\.x-eol$/m);
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

  it('says so when the frozen branch and the tag disagree', async () => {
    const cwd = await setup();
    // The two refs were made by hand, at different times.
    await git(['branch', 'el/v1.x'], cwd);
    await git(['push', 'origin', 'el/v1.x'], cwd);
    await commitFiles(cwd, { 'later.txt': 'later\n' }, 'fix: later');
    await git(['tag', 'v1.x-eol'], cwd);
    await git(['push', 'origin', 'v1.x-eol'], cwd);

    const result = await run(cwd, { date: '2027-02-01', force: true });

    assert.equal(result.exitCode, 0, JSON.stringify(result.problems));
    const noticed = result.problems.find(
      (problem) => problem.level === 'warning',
    );
    assert.ok(noticed, 'expected a warning about the disagreeing refs');
    assert.match(noticed.message, /point at different commits/);
  });
});

describe('eol keeps one freeze snapshot', () => {
  for (const annotated of [false, true]) {
    for (const localTag of ['conflicting', 'absent']) {
      it(`uses the remote ${annotated ? 'annotated' : 'lightweight'} tag with a ${localTag} local tag`, async () => {
        const cwd = await setup();
        const frozen = (await git(['rev-parse', 'HEAD'], cwd)).trim();
        await git(
          annotated
            ? ['tag', '-a', 'v1.x-eol', '-m', 'End of life']
            : ['tag', 'v1.x-eol'],
          cwd,
        );
        await git(['push', 'origin', 'refs/tags/v1.x-eol'], cwd);
        await git(['tag', '-d', 'v1.x-eol'], cwd);
        await git(['config', 'remote.origin.tagOpt', '--no-tags'], cwd);
        if (localTag === 'conflicting') {
          await commitFiles(cwd, { 'later.txt': 'later\n' }, 'Local change');
          await git(['tag', 'v1.x-eol'], cwd);
        }

        const result = await run(cwd, { date: '2027-02-01', force: true });

        assert.equal(result.exitCode, 0, JSON.stringify(result.problems));
        assert.equal(result.pushed, true);
        const branch = await git(
          ['ls-remote', 'origin', 'refs/heads/el/v1.x'],
          cwd,
        );
        assert.equal(branch.trim().split(/\s+/)[0], frozen);
      });
    }
  }

  it('retains fetch guidance when the remote tag commit is unavailable locally', async () => {
    const cwd = await setup({ tags: ['v1.x-eol'] });
    const before = await readSupportFile(cwd);
    const remote = (await git(['remote', 'get-url', 'origin'], cwd)).trim();
    const { cwd: publisher } = await makeGitRepo();
    await commitFiles(
      publisher,
      { 'remote-only.txt': 'frozen\n' },
      'Remote freeze',
    );
    await git(['tag', 'v1.x-eol'], publisher);
    await git(['push', '--force', remote, 'refs/tags/v1.x-eol'], publisher);
    await git(['config', 'remote.origin.tagOpt', '--no-tags'], cwd);

    const result = await run(cwd, { force: true, write: true });

    assert.equal(result.exitCode, 1);
    assert.equal(result.pushed, false);
    assert.equal(result.written, false);
    assert.match(result.problems[0].message, /git fetch origin tag v1\.x-eol/);
    assert.doesNotMatch(await remoteRefs(cwd), /refs\/heads\/el\/v1\.x/);
    assert.equal(await readSupportFile(cwd), before);
  });

  it('publishes the frozen branch and the tag together, or not at all', async () => {
    const cwd = await setup();
    const { mkdir, rm, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const remoteUrl = (await git(['remote', 'get-url', 'origin'], cwd)).trim();
    // Wedge the tag ref on the remote: without an atomic push the branch
    // below would still be published, leaving half a freeze behind.
    const lock = join(remoteUrl, 'refs', 'tags', 'v1.x-eol.lock');
    await mkdir(join(remoteUrl, 'refs', 'tags'), { recursive: true });
    await writeFile(lock, '', 'utf8');

    const result = await run(cwd, { date: '2027-02-01' });

    assert.equal(result.exitCode, 1);
    assert.match(result.problems[0].message, /git push failed/);
    const refs = await remoteRefs(cwd);
    assert.doesNotMatch(refs, /refs\/heads\/el\//);
    assert.doesNotMatch(refs, /refs\/tags\/v1\.x-eol/);

    await rm(lock, { force: true });
  });

  it('--force tags the branch that was already frozen, not a line that moved', async () => {
    const cwd = await setup();
    // The frozen branch made it to the remote; the tag never did.
    await git(['branch', 'el/v1.x'], cwd);
    await git(['push', 'origin', 'el/v1.x'], cwd);
    await git(['branch', '-D', 'el/v1.x'], cwd);
    const frozen = (await git(['rev-parse', 'origin/el/v1.x'], cwd)).trim();
    // The line has moved on since the freeze.
    await git(['checkout', 'ls/v1.x'], cwd);
    await commitFiles(cwd, { 'later.txt': 'later\n' }, 'fix: after the freeze');
    await git(['push', 'origin', 'ls/v1.x'], cwd);
    await git(['checkout', 'devel'], cwd);

    const result = await run(cwd, { date: '2027-02-01', force: true });

    assert.equal(result.exitCode, 0, JSON.stringify(result.problems));
    assert.equal(result.tagExisted, false);
    const refs = await remoteRefs(cwd);
    const tag = refs
      .split('\n')
      .find((line) => line.includes('refs/tags/v1.x-eol'));
    const branch = refs
      .split('\n')
      .find((line) => line.includes('refs/heads/el/v1.x'));
    // The tag marks the frozen branch, and the branch itself was not moved.
    assert.equal(tag.split(' ')[0], frozen);
    assert.equal(branch.split(' ')[0], frozen);
  });

  it('--force cuts the frozen branch from the tag that already marks the end', async () => {
    const cwd = await setup({ tags: ['v1.x-eol'] });
    const frozen = (await git(['rev-parse', 'refs/tags/v1.x-eol'], cwd)).trim();
    // The line has moved on since the tag was made.
    await git(['checkout', 'ls/v1.x'], cwd);
    await commitFiles(cwd, { 'later.txt': 'later\n' }, 'fix: after the tag');
    await git(['push', 'origin', 'ls/v1.x'], cwd);
    await git(['checkout', 'devel'], cwd);

    const result = await run(cwd, { date: '2027-02-01', force: true });

    assert.equal(result.exitCode, 0, JSON.stringify(result.problems));
    assert.equal(result.branchExisted, false);
    const refs = await remoteRefs(cwd);
    const branch = refs
      .split('\n')
      .find((line) => line.includes('refs/heads/el/v1.x'));
    assert.equal(branch.split(' ')[0], frozen);
  });
});

describe('eol alongside another lifecycle command', () => {
  const twoLines = supportYaml([
    { version: '1.x', stage: 'ls', eol: '2027-01-01' },
    { version: '2.x', stage: 'as' },
  ]);

  it('does not put another line back where it was', async () => {
    const cwd = await setup({
      support: twoLines,
      branches: ['ls/v1.x', 'as/v2.x'],
    });

    const result = await run(cwd, {
      date: '2027-02-01',
      write: true,
      // Another command graduates 2.x and commits it, while this freeze is
      // fetching. Writing 1.x from the snapshot taken before the fetch would
      // set 2.x back to as.
      git: gitWithAnotherCommand(cwd, () =>
        commitFiles(
          cwd,
          {
            'SUPPORT.yaml':
              '# yaml-language-server: $schema=example\n' +
              'lines:\n' +
              '  - version: "1.x"\n' +
              '    stage: ls\n' +
              '    eol: 2027-01-01\n' +
              '  - version: "2.x"\n' +
              '    stage: ls\n' +
              '    eol: 2028-01-01\n',
          },
          'chore: 2.x is in life support',
        ),
      ),
    });

    assert.equal(result.exitCode, 0, JSON.stringify(result.problems));
    assert.equal(result.pushed, true);
    assert.equal(result.written, true);

    const text = await readSupportFile(cwd);
    assert.match(text, /version: "1\.x"\n {4}stage: el\n {4}eol: 2027-02-01/);
    assert.match(text, /version: "2\.x"\n {4}stage: ls\n {4}eol: 2028-01-01/);
  });

  it('writes nothing when the line it is ending has already ended', async () => {
    const cwd = await setup({
      support: twoLines,
      branches: ['ls/v1.x', 'as/v2.x'],
    });

    const result = await run(cwd, {
      date: '2027-02-01',
      write: true,
      // The line reaches End of Life by another route while this run is
      // fetching, with a date of its own.
      git: gitWithAnotherCommand(cwd, () =>
        commitFiles(
          cwd,
          {
            'SUPPORT.yaml':
              '# a note Lifeline would not write\n' +
              'lines:\n' +
              '  - version: "1.x"\n' +
              '    stage: el\n' +
              '    eol: 2027-03-01\n' +
              '  - version: "2.x"\n' +
              '    stage: as\n',
          },
          'chore: 1.x ended',
        ),
      ),
    });

    // The freeze is still published: the code has to be kept either way. The
    // file is not rewritten over the transition that is already there.
    assert.equal(result.exitCode, 1);
    assert.equal(result.pushed, true);
    assert.equal(result.written, false);
    assert.equal(result.path, null);
    assert.match(result.problems[0].message, /1\.x is el with eol 2027-03-01/);
    assert.match(result.problems[0].message, /nothing was written/);

    const text = await readSupportFile(cwd);
    assert.match(text, /# a note Lifeline would not write/);
    assert.match(text, /eol: 2027-03-01/);
    assert.doesNotMatch(text, /eol: 2027-02-01/);
  });
});
