// The command-line interface.
//
// Only this file knows about argument parsing and how the output looks. Each
// command in `src/commands/` reads data and returns data; printing happens here.

import { readFileSync } from 'node:fs'; // node: prefix = built into Node
import { Command } from 'commander'; // third-party, installed from npm

import { backport } from './commands/backport.js';
import { check } from './commands/check.js';
import { init } from './commands/init.js';
import { readStatus } from './commands/status.js';
import { createGithubForge } from './forge/github.js';
import { createGit } from './git/git.js';

// Read the version from package.json so it is written down in one place only.
// import.meta.url is the URL of this file, so "../package.json" is the file
// next to src/.
const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

/**
 * Add `--cwd` and `--remote` to a command. They are added to the program and
 * to every sub-command, so both `lifeline --cwd x status` and
 * `lifeline status --cwd x` work.
 * @param {Command} command
 * @returns {Command} the same command, so calls can be chained
 */
function addGlobalOptions(command) {
  return command
    .option(
      '--cwd <dir>',
      'run as if lifeline was started in <dir>',
      process.cwd(),
    )
    .option('--remote <name>', 'git remote to use', 'origin');
}

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
  addGlobalOptions(program);

  const status = program
    .command('status')
    .description('Show every support line from SUPPORT.yaml.')
    .option('--json', 'print JSON instead of a table');
  addGlobalOptions(status);
  status.action(runStatus);

  const check = program
    .command('check')
    .description(
      'Check SUPPORT.yaml against itself and against the branches that exist.',
    )
    .option('--json', 'print problems as JSON')
    .option('--strict', 'treat warnings as errors')
    .option('--fetch', 'run git fetch first, to see remote branches too');
  addGlobalOptions(check);
  check.action(runCheck);

  const init = program
    .command('init')
    .description('Write a starting SUPPORT.yaml from the branches that exist.')
    .option('--force', 'overwrite an existing SUPPORT.yaml');
  addGlobalOptions(init);
  init.action(runInit);

  const backport = program
    .command('backport <sha>')
    .description(
      'Carry a commit from devel to a support branch, with a pull request.',
    )
    .requiredOption('--to <line>', 'target line, for example v1.x')
    .option(
      '--label <name>',
      'label for the pull request (security or critical for ls)',
    )
    .option('--branch-name <name>', 'name for the backport branch')
    .option('--title <text>', 'pull request title')
    .option('--no-pr', 'stop after pushing, without opening a pull request')
    .option('--dry-run', 'print the plan and change nothing')
    .option('--allow-unmerged', 'allow a commit that is not on <remote>/devel');
  addGlobalOptions(backport);
  backport.action(runBackport);

  return program;
}

/**
 * The action behind `lifeline status`.
 * @param {object} options Options of the `status` command itself.
 * @param {Command} command The status command, for merged global options.
 * @returns {Promise<void>}
 */
async function runStatus(_options, command) {
  // commander passes (options, command). optsWithGlobals() merges the
  // program-level --cwd/--remote with the ones given after `status`.
  const options = command.optsWithGlobals();
  const git = createGit({ cwd: options.cwd, remote: options.remote });
  const status = await readStatus({ cwd: options.cwd, git });

  if (options.json) {
    // JSON always goes to stdout, even when something is wrong, so that a
    // script can read the problems instead of guessing from the exit code.
    console.log(JSON.stringify(status, null, 2));
  } else if (status.outcome === 'ok') {
    console.log(formatStatusTable(status.rows));
    if (status.rows.length === 0) {
      console.log('No lines in SUPPORT.yaml.');
    }
    printProblems(status.problems);
  } else {
    printProblems(status.problems);
  }

  process.exitCode = status.exitCode;
}

/**
 * The action behind `lifeline check`.
 * @param {object} options Options of the `check` command itself.
 * @param {Command} command The check command, for merged global options.
 * @returns {Promise<void>}
 */
async function runCheck(_options, command) {
  const options = command.optsWithGlobals();
  const git = createGit({ cwd: options.cwd, remote: options.remote });
  const result = await check({
    cwd: options.cwd,
    git,
    fetch: options.fetch,
    strict: options.strict,
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printProblems(result.problems);
    if (result.problems.length === 0) {
      console.log(
        `OK: ${result.counts.lines} lines, ${result.counts.branches} branches.` +
          (result.fetched ? ' (fetched)' : ''),
      );
    }
  }

  process.exitCode = result.exitCode;
}

/**
 * The action behind `lifeline init`.
 * @param {object} options Options of the `init` command itself.
 * @param {Command} command The init command, for merged global options.
 * @returns {Promise<void>}
 */
async function runInit(_options, command) {
  const options = command.optsWithGlobals();
  const git = createGit({ cwd: options.cwd, remote: options.remote });
  const result = await init({ cwd: options.cwd, git, force: options.force });

  printProblems(result.problems);
  if (result.written) {
    console.log(`Wrote ${result.path}:`);
    console.log('');
    console.log(result.text.trimEnd());
    console.log('');
    console.log('Run "lifeline check" to review it, and commit it on devel.');
  }

  process.exitCode = result.exitCode;
}

/**
 * The action behind `lifeline backport`.
 * @param {string} sha The commit to backport, taken from the command name.
 * @param {object} _options Options of the `backport` command itself.
 * @param {Command} command The backport command, for merged global options.
 * @returns {Promise<void>}
 */
async function runBackport(sha, _options, command) {
  const options = command.optsWithGlobals();
  const cwd = options.cwd;
  const result = await backport({
    cwd,
    git: createGit({ cwd, remote: options.remote }),
    // Only this line knows which forge we use; an Octokit version later would
    // change nothing else.
    forge: createGithubForge({ cwd }),
    remote: options.remote,
    sha,
    to: options.to,
    label: options.label ?? null,
    branchName: options.branchName ?? null,
    title: options.title ?? null,
    // commander turns --no-pr into options.pr === false
    noPr: options.pr === false,
    dryRun: options.dryRun,
    allowUnmerged: options.allowUnmerged,
  });

  if (result.plan) {
    console.log(formatBackportPlan(result.plan));
  }
  if (result.done) {
    console.log(`Pushed to ${options.remote}/${result.plan.branch}.`);
  }
  for (const step of result.steps) {
    console.log(step);
  }
  printProblems(result.problems);

  process.exitCode = result.exitCode;
}

/**
 * Describe a plan as a list of git commands, for --dry-run and for the record.
 * @param {import('./core/backport.js').Plan} plan
 * @returns {string} Multi-line text.
 */
function formatBackportPlan(plan) {
  const lines = [
    `Target: ${plan.version} (${plan.stage}) on ${plan.baseRef}`,
    `Commit: ${plan.sha} (${plan.shortSha})`,
    `Branch: ${plan.branch}`,
    `Would run: git ${plan.cherryPick.join(' ')}`,
    `Would run: git ${plan.push.join(' ')}`,
  ];
  if (plan.pullRequest) {
    lines.push(`Would open a pull request: "${plan.title}"`);
    lines.push(`Would use body:\n${indent(plan.body, '  ')}`);
    if (plan.labels.length > 0) {
      lines.push(`Labels: ${plan.labels.join(', ')}`);
    }
  } else {
    lines.push('Would stop after pushing: --no-pr');
  }
  return lines.join('\n');
}

/** Put a space in front of every line but the first. */
function indent(text, prefix) {
  return text
    .split('\n')
    .map((line, index) => (index === 0 ? line : `${prefix}${line}`))
    .join('\n');
}

/**
 * Render the status table: fixed column order, columns padded with spaces.
 * No table library; a few string operations is all it takes.
 * @param {import('./commands/status.js').StatusRow[]} rows
 * @returns {string} Multi-line text, without a trailing newline.
 */
export function formatStatusTable(rows) {
  const header = ['VERSION', 'STAGE', 'BRANCH', 'EXISTS', 'EOL', 'DAYS TO EOL'];
  const body = rows.map((row) => [
    row.version,
    row.stage,
    row.branch ?? '-',
    // "?" means we could not ask git, e.g. outside a repository.
    row.exists === null ? '?' : row.exists ? 'yes' : 'no',
    row.eol ?? '-',
    row.daysUntilEol === null ? '-' : String(row.daysUntilEol),
  ]);

  // The widest cell in each column sets that column's width.
  const widths = header.map((title, index) =>
    Math.max(title.length, ...body.map((cells) => cells[index].length)),
  );

  const line = (cells) =>
    cells
      .map((cell, index) =>
        // Numbers read better right-aligned; text reads better left-aligned.
        index === cells.length - 1
          ? cell.padStart(widths[index])
          : cell.padEnd(widths[index]),
      )
      // Padding at the end of the last column would show up in git diffs.
      .join('  ')
      .trimEnd();

  return [header, ...body].map(line).join('\n');
}

/** Write problems to stderr, one per line, as "error: ..." or "warning: ...". */
function printProblems(problems) {
  for (const problem of problems) {
    console.error(`${problem.level}: ${problem.message}`);
  }
}

/**
 * Parse the arguments and run the chosen command.
 * @param {string[]} argv Normally `process.argv`.
 * @returns {Promise<void>}
 */
export async function runCli(argv) {
  const program = buildProgram();
  disableExit(program);

  try {
    // parseAsync waits for async actions, so set process.exitCode afterwards.
    await program.parseAsync(argv);
  } catch (cliError) {
    // --help and --version are successes, not usage errors.
    if (HELP_CODES.has(cliError.code)) {
      return;
    }
    // commander has already printed the message on stderr.
    process.exitCode = 2;
  }
}

/**
 * Stop commander from calling process.exit() itself, on this command and on
 * every sub-command. It then throws instead, and we choose the exit code.
 * @param {Command} command
 * @returns {Command} the same command
 */
function disableExit(command) {
  command.exitOverride();
  for (const subCommand of command.commands) {
    disableExit(subCommand);
  }
  return command;
}

/** commander error codes that mean "we printed help and that is fine". */
const HELP_CODES = new Set([
  'commander.help',
  'commander.helpDisplayed',
  'commander.version',
]);
