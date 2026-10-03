// A support-file write that a test cuts off part way through.
//
// The write is stopped by the file size limit the test puts on this process,
// so it fails for real in the middle of the file rather than at the start or
// not at all: what a full disk does, and what losing power can do. It runs as
// its own process because that limit belongs to a process, not to a file, and
// because only then can a write be interrupted on demand.
//
// The body is a valid SUPPORT.yaml, padded so it cannot fit inside the limit,
// so a file that did get through whole can be told from one that did not.
//
// Usage: node interrupted-write.js <directory> [create|replace]

import { createSupport, writeSupport } from '../../src/support-file.js';

const [cwd, mode = 'create'] = process.argv.slice(2);

/** Padding on the end of the body: more than any limit a test would set. */
const PADDING = 64 * 1024;

/** The whole file this writes, padding included. */
export const BODY =
  'lines:\n  - version: "1.x"\n    stage: indev\n' +
  `#${'x'.repeat(PADDING)}\n`;

/** Its length in bytes, for a test to measure a survivor against. */
export const BODY_SIZE = Buffer.byteLength(BODY);

try {
  await (mode === 'replace' ? writeSupport : createSupport)(cwd, BODY);
  console.log(JSON.stringify({ written: true }));
} catch (thrown) {
  // What the write did before it was stopped, so a test can tell an interrupted
  // write from one that was never in trouble.
  console.log(JSON.stringify({ written: false, code: thrown.code ?? null }));
}
