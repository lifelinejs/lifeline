// Data for `lifeline check`.
//
// Like the other commands, this one takes what it needs as an argument object
// and returns data. `git` is the object from src/git/git.js (or a fake), so a
// test can check a repository it built in a temporary directory without any
// network access.

import { checkAgainstRepo, checkLines } from '../core/checks.js';
import { error } from '../core/problems.js';
import { eolTagName } from '../core/stages.js';
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
 * @param {{git: Git, fetch?: boolean, lines?: import('../core/support.js').Line[],
 *   now?: Date}} options `lines` is what `--fetch` asks tags for: the file says
 *   which `vN.x-eol` tags should exist, and `git fetch` alone does not bring
 *   them down.
 * @returns {Promise<RepoFacts>} Branch and tag names, plus "now".
 */
export async function readRepoFacts({
  git,
  fetch = false,
  lines = [],
  now = new Date(),
}) {
  if (fetch) {
    await git.fetchRemote();
    // fetchRemote only follows tags that point into what it fetched, so a tag
    // that has been on the remote all along can still be missing here. The
    // rules below ask about the tags the file expects, so ask for those by
    // name before reading the tag list. A tag the remote does not have is not
    // an error here: that is one of the findings.
    for (const tag of expectedEolTags(lines)) {
      await git.fetchTag(tag);
    }
  }
  const [branches, tags] = await Promise.all([git.branches(), git.tags()]);
  // The clock is a fact about this run, so it travels with the other facts and
  // tests can hand in their own "today".
  return { branches, tags, now };
}

/**
 * The `vN.x-eol` tags the file says should be there: one per line at stage el.
 * A Set, because two entries for one version would be asked for twice.
 * @param {import('../core/support.js').Line[]} lines
 * @returns {string[]}
 */
function expectedEolTags(lines) {
  return [
    ...new Set(
      lines
        .filter((line) => line.stage === 'el')
        .map((line) => eolTagName(line.version)),
    ),
  ];
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
    const facts = await readRepoFacts({ git, fetch, lines: loaded.lines, now });
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
