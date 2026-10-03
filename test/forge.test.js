// Tests for the GitHub forge. These use a fake `gh` script instead of the real
// tool, so no test needs GitHub installed, logged in, or reachable.

import { chmod, readFile, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { createGithubForge, preflight } from '../src/forge/github.js';
import { makeTempDir } from './helpers.js';

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
    await useFakeGh();
    const forge = createGithubForge();

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
      /pr create --base ls\/v1\.x --head backport\/1\.x\/abc1234/,
    );
    assert.match(logged, /--title \[v1\.x\] fix: a thing/);
    assert.match(logged, /--label security/);
  });

  it('omits --label when there are no labels', async () => {
    await useFakeGh();
    const forge = createGithubForge();

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
    await useFakeGh();
    process.env.LIFELINE_TEST_GH_PR_FAIL = '1';
    try {
      await assert.rejects(
        () =>
          createGithubForge().createPullRequest({
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
