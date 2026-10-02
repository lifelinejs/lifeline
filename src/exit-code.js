// The exit codes, in one place, so every command agrees.
//
//   0  success, nothing to report
//   1  Lifeline did its job and found problems
//   2  usage or configuration error: bad flags, or a support file that is
//      missing or cannot be parsed

/**
 * @typedef {import('./core/problems.js').Problem} Problem
 */

/**
 * Work out the exit code from what a command found.
 *
 * `configProblems` are the ones about reading the file itself; those mean
 * Lifeline could not do its job at all. `problems` are the findings.
 *
 * @param {object} options
 * @param {Problem[]} [options.configProblems] Problems from reading the file.
 * @param {Problem[]} [options.problems] Findings from the checks.
 * @param {boolean} [options.strict] With --strict, warnings count as errors.
 * @returns {0 | 1 | 2}
 */
export function exitCodeFor({
  configProblems = [],
  problems = [],
  strict = false,
}) {
  if (configProblems.some((problem) => problem.level === 'error')) {
    return 2;
  }
  if (strict ? problems.length > 0 : hasErrors(problems)) {
    return 1;
  }
  return 0;
}

/** True when at least one problem is an error. */
export function hasErrors(problems) {
  return problems.some((problem) => problem.level === 'error');
}

/**
 * Present every problem as an error. Used by --strict, so that the printed
 * output and --json agree with the exit code.
 * @param {Problem[]} problems
 * @returns {Problem[]}
 */
export function asAllErrors(problems) {
  return problems.map((problem) => ({ ...problem, level: 'error' }));
}
