// Tests for src/core/support.js, which turns SUPPORT.yaml text into lines.

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseSupport } from '../src/core/support.js';

/** Only the error-level problems, as an array of strings. */
function errors(problems) {
  return problems
    .filter((problem) => problem.level === 'error')
    .map((p) => p.message);
}

/** Only the warning-level problems, as an array of strings. */
function warnings(problems) {
  return problems
    .filter((problem) => problem.level === 'warning')
    .map((p) => p.message);
}

test('reads a full, valid file', () => {
  const text = `
lines:
  - version: "3.x"
    stage: indev
  - version: "2.x"
    stage: as
    components: [api, web, cli]
  - version: "1.x"
    stage: ls
    eol: 2027-03-01
  - version: "0.x"
    stage: el
`;
  const { lines, problems } = parseSupport(text);

  assert.deepEqual(problems, []);
  assert.deepEqual(lines, [
    { version: '3.x', stage: 'indev', eol: undefined, components: undefined },
    {
      version: '2.x',
      stage: 'as',
      eol: undefined,
      components: ['api', 'web', 'cli'],
    },
    { version: '1.x', stage: 'ls', eol: '2027-03-01', components: undefined },
    { version: '0.x', stage: 'el', eol: undefined, components: undefined },
  ]);
});

test('the yaml package returns eol as a string, not a Date', () => {
  // This is why Lifeline says `eol` must be quoted-free YYYY-MM-DD text: in
  // YAML 1.2 a bare 2027-03-01 has no type of its own, so it stays a string.
  const { lines } = parseSupport(
    'lines:\n  - version: "1.x"\n    stage: ls\n    eol: 2027-03-01\n',
  );

  assert.equal(typeof lines[0].eol, 'string');
  assert.equal(lines[0].eol, '2027-03-01');
  assert.ok(!(lines[0].eol instanceof Date));
});

test('a quoted eol is also fine', () => {
  const { lines } = parseSupport(
    'lines:\n  - version: "1.x"\n    stage: ls\n    eol: "2027-03-01"\n',
  );
  assert.equal(lines[0].eol, '2027-03-01');
});

test('reports invalid YAML as an error', () => {
  const { lines, problems } = parseSupport(
    'lines:\n  - version: "1.x"\n   stage: ls\n',
  );
  assert.deepEqual(lines, []);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].level, 'error');
  assert.match(problems[0].message, /not valid YAML/);
});

test('reports an empty file as an error', () => {
  const { problems } = parseSupport('');
  assert.match(errors(problems)[0], /must be a mapping/);
});

test('reports a missing lines list as an error', () => {
  const { problems } = parseSupport('other: true\n');
  assert.match(errors(problems)[0], /must have a "lines" list/);
});

test('reports lines that are not a list as an error', () => {
  const { problems } = parseSupport('lines:\n  version: "1.x"\n');
  assert.match(errors(problems)[0], /must have a "lines" list/);
});

test('warns about a file with no lines', () => {
  const { lines, problems } = parseSupport('lines: []\n');
  assert.deepEqual(lines, []);
  assert.match(warnings(problems)[0], /lists no lines/);
});

test('reports a line entry that is not a mapping', () => {
  const { problems } = parseSupport('lines:\n  - "1.x"\n');
  assert.match(errors(problems)[0], /lines\[1\] must be a mapping/);
});

test('reports a missing version', () => {
  const { lines, problems } = parseSupport('lines:\n  - stage: as\n');
  assert.deepEqual(lines, []);
  assert.match(
    errors(problems)[0],
    /lines\[1\] needs a "version" string like "2\.x"/,
  );
});

test('reports a missing stage', () => {
  const { lines, problems } = parseSupport('lines:\n  - version: "1.x"\n');
  assert.deepEqual(lines, []);
  assert.match(
    errors(problems)[0],
    /lines\[1\] needs a "stage" of indev, as, ls, el/,
  );
});

test('reports a bad version format', () => {
  const { problems } = parseSupport(
    'lines:\n  - version: "2.1"\n    stage: as\n',
  );
  assert.match(errors(problems)[0], /needs a "version" string like "2\.x"/);
});

test('reports a bad stage', () => {
  const { problems } = parseSupport(
    'lines:\n  - version: "2.x"\n    stage: beta\n',
  );
  assert.match(errors(problems)[0], /needs a "stage" of indev, as, ls, el/);
});

test('reports a bad eol and drops the whole line', () => {
  const { lines, problems } = parseSupport(
    'lines:\n  - version: "1.x"\n    stage: ls\n    eol: "next spring"\n',
  );
  assert.deepEqual(lines, []);
  assert.match(errors(problems)[0], /"eol" that is not a YYYY-MM-DD string/);
});

test('reports a numeric eol', () => {
  const { problems } = parseSupport(
    'lines:\n  - version: "1.x"\n    stage: ls\n    eol: 2027\n',
  );
  assert.match(
    errors(problems)[0],
    /"eol" that is not a YYYY-MM-DD string \(got number 2027\)/,
  );
});

test('reports an eol that is formatted right but is not a real date', () => {
  const { problems } = parseSupport(
    'lines:\n  - version: "1.x"\n    stage: ls\n    eol: 2027-13-01\n',
  );
  assert.match(errors(problems)[0], /not a real date/);
});

test('reports components that are not a list of strings', () => {
  const { problems } = parseSupport(
    'lines:\n  - version: "2.x"\n    stage: as\n    components: api\n',
  );
  assert.match(
    errors(problems)[0],
    /"components" that is not a list of strings/,
  );
});

test('warns about an unknown key but keeps the line', () => {
  const { lines, problems } = parseSupport(
    'lines:\n  - version: "1.x"\n    stage: ls\n    eol: 2027-03-01\n    branch: ls/v1.x\n',
  );
  assert.equal(lines.length, 1);
  assert.deepEqual(errors(problems), []);
  assert.match(warnings(problems)[0], /Unknown key "branch" in lines\[1\]/);
});

test('warns about an unknown top-level key', () => {
  const { problems } = parseSupport('lines: []\npolicies: {}\n');
  assert.match(
    warnings(problems).join(' '),
    /Unknown key "policies" in SUPPORT\.yaml/,
  );
});

test('reports every bad line, not just the first', () => {
  const { lines, problems } = parseSupport(
    'lines:\n  - version: "2.1"\n    stage: as\n  - version: "1.x"\n    stage: beta\n',
  );
  assert.deepEqual(lines, []);
  assert.equal(errors(problems).length, 2);
  assert.match(errors(problems)[1], /lines\[2\]/);
});
