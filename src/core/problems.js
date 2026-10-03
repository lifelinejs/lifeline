/**
 * A "problem" is a finding about the support file or the repository.
 *
 * Lifeline never throws or prints problems inside `src/core`: it returns them,
 * so `status`, `check` and `--json` output can all share the same objects.
 *
 * @typedef {Object} Problem
 * @property {'error' | 'warning'} level How serious the finding is.
 * @property {string} message One sentence, written for a human.
 */

/**
 * Build an error-level problem.
 * @param {string} message
 * @returns {Problem}
 */
export function error(message) {
  return { level: 'error', message };
}

/**
 * Build a warning-level problem.
 * @param {string} message
 * @returns {Problem}
 */
export function warning(message) {
  return { level: 'warning', message };
}
