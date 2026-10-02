// Helpers for tests. Shared setup, so each test file stays about one thing.

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Create a throwaway directory, optionally filling it with files.
 * @param {Record<string, string>} [files] File name -> contents.
 * @returns {Promise<string>} The directory path.
 */
export async function makeTempDir(files = {}) {
  // mkdtemp makes a unique directory inside the system temp folder.
  const dir = await mkdtemp(join(tmpdir(), 'lifeline-test-'));
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, 'utf8');
  }
  return dir;
}

/** A SUPPORT.yaml body with sensible defaults, for tests that need one. */
export function supportYaml(lines = [{ version: '2.x', stage: 'as' }]) {
  const body = lines
    .map((line) => {
      // A list entry starts with "- " and every following key has to line up
      // under the first one, four spaces in.
      const fields = [`version: "${line.version}"`, `stage: ${line.stage}`];
      if (line.eol) {
        fields.push(`eol: ${line.eol}`);
      }
      return `  - ${fields.join('\n    ')}`;
    })
    .join('\n');
  return `lines:\n${body}\n`;
}
