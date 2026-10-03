// Tests for the GitHub forge. These use a fake `gh` script instead of the real
// tool, so no test needs GitHub installed, logged in, or reachable.

import { chmod, readFile, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import {
  createGithubForge,
  parseRepositoryUrl,
  preflight,
} from '../src/forge/github.js';
import { backport } from '../src/commands/backport.js';
import { git, makeTempDir, supportYaml } from './helpers.js';

// The fake tool answers whatever the test asks it to, through environment
// variables it inherits from this process.
const FAKE_GH = `#!/bin/sh
echo "$@" >> "$LIFELINE_TEST_GH_LOG"
case "$1" in
  --version)
    echo "gh version 2.0.0 (fake)"
    exit 0
    ;;
  auth)
    if [ -n "$LIFELINE_TEST_GH_AUTH_FAIL" ]; then
      echo "not logged in" >&2
      exit 1
    fi
    exit 0
    ;;
  repo)
    if [ -n "$LIFELINE_TEST_GH_REPO_FAIL" ]; then
      echo "repository not accessible through GitHub API" >&2
      exit 1
    fi
    echo '{"id":"R_test"}'
    exit 0
    ;;
  pr)
    if [ -n "$LIFELINE_TEST_GH_PR_FAIL" ]; then
      echo "no pull requests for you" >&2
      exit 1
    fi
    echo "$LIFELINE_TEST_GH_PR_URL"
    exit 0
    ;;
esac
exit 0
`;

/** Where the fake gh logs its arguments, for the tests to read back. */
let logPath = '';

/** The PATH as it was before any test put a fake gh on it, or null. */
let originalPath = null;

/**
 * A throwaway repository with two GitHub remotes, so a forge has a real
 * remote to bind its pull requests to.
 * @returns {Promise<string>} The repository directory.
 */
async function makeGitHubRepo() {
  const cwd = await makeTempDir();
  await git(['init', '-q', '-b', 'devel'], cwd);
  await git(['remote', 'add', 'origin', 'git@github.com:org/one.git'], cwd);
  await git(
    ['remote', 'add', 'upstream', 'https://github.com/org/two.git'],
    cwd,
  );
  return cwd;
}

/**
 * Put a fake `gh` at the front of PATH, and tidy the environment again later.
 * @returns {Promise<void>}
 */
async function useFakeGh() {
  const dir = await makeTempDir();
  const script = join(dir, 'gh');
  await writeFile(script, FAKE_GH, 'utf8');
  await chmod(script, 0o755);
  logPath = join(dir, 'gh.log');

  // Remember the real PATH once, before the first fake is put on it, so the
  // after hook can restore it exactly.
  if (originalPath === null) {
    originalPath = process.env.PATH;
  }
  process.env.PATH = `${dir}${delimiter}${process.env.PATH}`;
  process.env.LIFELINE_TEST_GH_LOG = logPath;
  process.env.LIFELINE_TEST_GH_PR_URL = 'https://github.test/org/repo/pull/12';
}

after(async () => {
  if (originalPath !== null) {
    process.env.PATH = originalPath;
    originalPath = null;
  }
  delete process.env.LIFELINE_TEST_GH_LOG;
  delete process.env.LIFELINE_TEST_GH_PR_URL;
  delete process.env.LIFELINE_TEST_GH_AUTH_FAIL;
  delete process.env.LIFELINE_TEST_GH_PR_FAIL;
  delete process.env.LIFELINE_TEST_GH_REPO_FAIL;
});

describe('github forge preflight', () => {
  it('passes when gh is installed and logged in', async () => {
    await useFakeGh();
    await assert.doesNotReject(() => preflight());
  });

  it('asks for the CLI when gh is not installed', async () => {
    // An empty directory on PATH hides any real gh.
    const empty = await makeTempDir();
    const old = process.env.PATH;
    process.env.PATH = empty;
    try {
      await assert.rejects(
        () => preflight(),
        (thrown) => {
          assert.match(thrown.message, /install it and run `gh auth login`/);
          return true;
        },
      );
    } finally {
      process.env.PATH = old;
    }
  });

  it('asks for a login when gh is not signed in', async () => {
    await useFakeGh();
    process.env.LIFELINE_TEST_GH_AUTH_FAIL = '1';
    try {
      await assert.rejects(
        () => preflight(),
        (thrown) => {
          assert.equal(
            thrown.message,
            'backport needs the GitHub CLI; run `gh auth login` to sign in',
          );
          return true;
        },
      );
    } finally {
      delete process.env.LIFELINE_TEST_GH_AUTH_FAIL;
    }
  });
});

describe('github forge pull requests', () => {
  it('passes the request to gh as separate arguments', async () => {
    const cwd = await makeGitHubRepo();
    await useFakeGh();
    const forge = createGithubForge({ cwd });

    const result = await forge.createPullRequest({
      base: 'ls/v1.x',
      head: 'backport/1.x/abc1234',
      title: '[v1.x] fix: a thing',
      body: 'Backport of abc1234',
      labels: ['security'],
    });

    assert.equal(result.url, 'https://github.test/org/repo/pull/12');
    const logged = await readFile(logPath, 'utf8');
    assert.match(
      logged,
      /pr create --repo github\.com\/org\/one --base ls\/v1\.x --head backport\/1\.x\/abc1234/,
    );
    assert.match(logged, /--title \[v1\.x\] fix: a thing/);
    assert.match(logged, /--label security/);
  });

  it('omits --label when there are no labels', async () => {
    const cwd = await makeGitHubRepo();
    await useFakeGh();
    const forge = createGithubForge({ cwd });

    await forge.createPullRequest({
      base: 'as/v2.x',
      head: 'backport/2.x/abc1234',
      title: 'A title',
      body: 'A body',
    });

    const logged = await readFile(logPath, 'utf8');
    assert.doesNotMatch(logged, /--label/);
  });

  it('reports what gh said when the pull request fails', async () => {
    const cwd = await makeGitHubRepo();
    await useFakeGh();
    process.env.LIFELINE_TEST_GH_PR_FAIL = '1';
    try {
      await assert.rejects(
        () =>
          createGithubForge({ cwd }).createPullRequest({
            base: 'as/v2.x',
            head: 'backport/2.x/abc1234',
            title: 'A title',
            body: 'A body',
          }),
        (thrown) => {
          assert.match(thrown.message, /gh pr create failed/);
          assert.match(thrown.message, /no pull requests for you/);
          return true;
        },
      );
    } finally {
      delete process.env.LIFELINE_TEST_GH_PR_FAIL;
    }
  });
});

describe('binding pull requests to a remote', () => {
  for (const host of ['github.com', 'github.example.com']) {
    it(`checks repository access on ${host} during preflight`, async () => {
      const cwd = await makeGitHubRepo();
      await git(
        ['remote', 'set-url', 'origin', `https://${host}/org/repo.git`],
        cwd,
      );
      await git(
        ['remote', 'set-url', '--push', 'origin', `git@${host}:org/repo.git`],
        cwd,
      );
      await useFakeGh();

      await createGithubForge({ cwd }).preflight();

      const logged = (await readFile(logPath, 'utf8')).trim().split('\n');
      assert.deepEqual(logged, [
        '--version',
        'auth status',
        `repo view ${host}/org/repo --json id`,
      ]);
    });
  }

  const invalidRemotes = [
    {
      name: 'an unsupported host',
      fetch: 'https://gitlab.com/org/repo.git',
      apiFails: true,
    },
    { name: 'an inaccessible GitHub repository', apiFails: true },
    {
      name: 'a different push repository',
      push: 'git@github.com:fork/one.git',
    },
    { name: 'a different push host', push: 'git@gitlab.com:org/one.git' },
    {
      name: 'an additional push destination',
      push: 'git@github.com:fork/one.git',
      additional: true,
    },
    { name: 'a local push destination', push: '/srv/mirror/repo.git' },
  ];
  for (const scenario of invalidRemotes) {
    it(`rejects ${scenario.name} before backport creates or pushes a branch`, async () => {
      const cwd = await makeGitHubRepo();
      await writeFile(join(cwd, 'SUPPORT.yaml'), supportYaml());
      if (scenario.fetch) {
        await git(['remote', 'set-url', 'origin', scenario.fetch], cwd);
      }
      if (scenario.additional) {
        await git(
          [
            'remote',
            'set-url',
            '--push',
            'origin',
            'git@github.com:org/one.git',
          ],
          cwd,
        );
      }
      if (scenario.push) {
        await git(
          ['remote', 'set-url', '--push', '--add', 'origin', scenario.push],
          cwd,
        );
      }
      await useFakeGh();
      if (scenario.apiFails) {
        process.env.LIFELINE_TEST_GH_REPO_FAIL = '1';
      }
      const mutations = [];
      try {
        const result = await backport({
          cwd,
          forge: createGithubForge({ cwd }),
          sha: 'abc1234',
          to: '2.x',
          git: {
            isClean: async () => true,
            commit: async () => ({
              sha: 'abc1234',
              shortSha: 'abc1234',
              parents: ['def5678'],
              subject: 'Fix',
            }),
            fetchRemote: async () => {},
            branchExists: async () => true,
            isAncestor: async () => true,
            run: async (args) => {
              mutations.push(args);
              return '';
            },
          },
        });

        assert.equal(result.exitCode, 1);
        assert.equal(result.pushed, false);
        assert.match(
          result.problems[0].message,
          scenario.apiFails
            ? /accessible GitHub repository/
            : scenario.push.startsWith('/')
              ? /not a repository URL/
              : /different fetch and push repositories/,
        );
        assert.deepEqual(mutations, []);
        assert.doesNotMatch(await readFile(logPath, 'utf8'), /pr create/);
      } finally {
        delete process.env.LIFELINE_TEST_GH_REPO_FAIL;
      }
    });
  }

  it('names the repository the selected remote points at', async () => {
    const cwd = await makeGitHubRepo();
    await useFakeGh();
    const forge = createGithubForge({ cwd, remote: 'upstream' });

    await forge.createPullRequest({
      base: 'as/v2.x',
      head: 'backport/2.x/abc1234',
      title: 'A title',
      body: 'A body',
      labels: [],
    });

    const logged = await readFile(logPath, 'utf8');
    assert.match(
      logged,
      /pr create --repo github\.com\/org\/two --base as\/v2\.x/,
    );
  });

  it('refuses when the remote is not a GitHub repository', async () => {
    const cwd = await makeTempDir();
    await git(['init', '-q', '-b', 'devel'], cwd);
    await git(['remote', 'add', 'origin', '/srv/mirror/lifeline.git'], cwd);
    await useFakeGh();

    await assert.rejects(
      () =>
        createGithubForge({ cwd }).createPullRequest({
          base: 'as/v2.x',
          head: 'backport/2.x/abc1234',
          title: 'A title',
          body: 'A body',
        }),
      (thrown) => {
        assert.match(thrown.message, /not a repository URL/);
        return true;
      },
    );

    // gh was never asked to create anything.
    await assert.rejects(() => readFile(logPath, 'utf8'));
  });

  it('fails the preflight when the remote is not configured', async () => {
    const cwd = await makeTempDir();
    await git(['init', '-q', '-b', 'devel'], cwd); // no remotes at all
    await useFakeGh();

    await assert.rejects(
      () => createGithubForge({ cwd }).preflight(),
      (thrown) => {
        assert.match(thrown.message, /remote "origin" is not configured/);
        return true;
      },
    );
  });
});

describe('reading a repository out of a remote URL', () => {
  it('handles the URL shapes git allows', () => {
    assert.equal(
      parseRepositoryUrl('https://github.com/org/repo.git'),
      'github.com/org/repo',
    );
    assert.equal(
      parseRepositoryUrl('https://user@github.com/org/repo'),
      'github.com/org/repo',
    );
    assert.equal(
      parseRepositoryUrl('git@github.com:org/repo.git'),
      'github.com/org/repo',
    );
    assert.equal(
      parseRepositoryUrl('ssh://git@github.com/org/repo'),
      'github.com/org/repo',
    );
    assert.equal(
      parseRepositoryUrl('git://github.com/org/repo.git'),
      'github.com/org/repo',
    );
    assert.equal(
      parseRepositoryUrl('https://github.example.com/org/repo/'),
      'github.example.com/org/repo',
    );
  });

  it('refuses anything that is not a repository URL', () => {
    assert.throws(() => parseRepositoryUrl('/srv/mirror/repo.git'), {
      message: /not a repository URL/,
    });
    assert.throws(() => parseRepositoryUrl('../sibling/repo'), {
      message: /not a repository URL/,
    });
    for (const url of [
      'file://github.com/org/repo',
      'ftp://github.com/org/repo',
      'https://github.com/org',
      'https://github.com/org/repo/extra',
      'git@github.com:org/repo/extra',
      'https://github.com/org/repo?ref=main',
      'https://github.com/org/repo#main',
    ]) {
      assert.throws(() => parseRepositoryUrl(url), {
        message: /not a repository URL/,
      });
    }
    assert.throws(() => parseRepositoryUrl(''), {
      message: /not a repository URL/,
    });
  });
});
