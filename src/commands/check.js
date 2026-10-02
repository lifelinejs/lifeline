// Data for `lifeline check`.
//
// Like the other commands, this one takes what it needs as an argument object
// and returns data. `git` is the object from src/git/git.js (or a fake), so a
// test can check a repository it built in a temporary directory without any
// network access.

import { checkAgainstRepo, checkLines } from '../core/checks.js';
import { error } from '../core/problems.js';
import { asAllErrors, exitCodeFor } from '../exit-code.js';
import { loadSupport } from '../support-file.js';

/**
 * @typedef {import('../core/checks.js').RepoFacts} RepoFacts
 * @typedef {import('../git/git.js').Git} Git
 */

/**
 * Everything `lifeline check` reports.
 *
 * @typedef {Object} CheckResult
 * @property {'ok' | 'missing' | 'unreadable'} outcome Did we get the file?
 * @property {boolean} fetched Whether we ran `git fetch`.
 * @property {{lines: number, branches: number, tags: number}} counts
 * @property {import('../core/problems.js').Problem[]} problems
 * @property {0 | 1 | 2} exitCode
 */

/**
 * Read the repository facts the rules need.
 *
 * Only local and remote-tracking refs are read, so `check` never touches the
 * network unless `fetch` is true.
 *
 * @param {{git: Git, fetch?: boolean, now?: Date}} options
 * @returns {Promise<RepoFacts>} Branch and tag names, plus "now".
 */
export async function readRepoFacts({ git, fetch = false, now = new Date() }) {
  if (fetch) {
    await git.fetchRemote();
  }
  const [branches, tags] = await Promise.all([git.branches(), git.tags()]);
  // The clock is a fact about this run, so it travels with the other facts and
  // tests can hand in their own "today".
  return { branches, tags, now };
}

/**
 * Check SUPPORT.yaml against itself and against the repository.
 * @param {{cwd: string, git: Git, fetch?: boolean, strict?: boolean, now?: Date}} options
 * @returns {Promise<CheckResult>}
 */
export async function check({
  cwd,
  git,
  fetch = false,
  strict = false,
  now = new Date(),
}) {
  const loaded = await loadSupport(cwd);

  /** @type {import('../core/problems.js').Problem[]} */
  let findings = [...checkLines(loaded.lines)];

  // A git failure is an error, not a crash: check should still print every
  // other problem it found.
  let counts = { lines: loaded.lines.length, branches: 0, tags: 0 };
  try {
    const facts = await readRepoFacts({ git, fetch, now });
    counts = {
      lines: loaded.lines.length,
      branches: facts.branches.length,
      tags: facts.tags.length,
    };
    findings = [...findings, ...checkAgainstRepo(loaded.lines, facts)];
  } catch (gitError) {
    findings.push(error(`Could not read the repository: ${gitError.message}`));
  }

  // --strict means warnings fail too, in the output as well as the exit code.
  const problems = strict ? asAllErrors(findings) : findings;

  return {
    outcome: loaded.outcome,
    fetched: fetch,
    counts,
    problems: [...loaded.problems, ...problems],
    exitCode: exitCodeFor({
      configProblems: loaded.problems,
      problems,
      strict,
    }),
  };
}
