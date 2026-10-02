// The command-line interface.
//
// Only this file knows about argument parsing. Each command in `src/commands/`
// does the real work.

import { readFileSync } from 'node:fs'; // node: prefix = built into Node
import { Command } from 'commander'; // third-party, installed from npm

// Read the version from package.json so it is written down in one place only.
// import.meta.url is the URL of this file, so "../package.json" is the file
// next to src/.
const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

/**
 * Build the commander program. Returns it instead of parsing, so tests can
 * inspect the commands without running anything.
 * @returns {Command}
 */
export function buildProgram() {
  const program = new Command();
  program
    .name('lifeline')
    .description(
      'Manage the Active Support / Life Support lifecycle of release lines.',
    )
    .version(packageJson.version);
  return program;
}

/**
 * Parse the arguments and run the chosen command.
 * @param {string[]} argv Normally `process.argv`.
 * @returns {Promise<void>}
 */
export async function runCli(argv) {
  const program = buildProgram();
  program.parse(argv);
}
