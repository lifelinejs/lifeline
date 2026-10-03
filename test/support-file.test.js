import test from 'node:test';
import assert from 'node:assert/strict';
import { open, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { withSupportLock } from '../src/support-file.js';
import { holdSupportLock, makeTempDir } from './helpers.js';

test('a failed PID write returns a problem and releases the lock', async (t) => {
  const cwd = await makeTempDir();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const probe = await open(join(cwd, 'probe'), 'w');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();

  let lockHandle;
  const write = t.mock.method(prototype, 'writeFile', async function () {
    lockHandle = this;
    throw new Error('disk full');
  });
  const work = t.mock.fn();

  const result = await withSupportLock(cwd, work);

  assert.equal(result.ok, false);
  assert.equal(result.problem.level, 'error');
  assert.match(
    result.problem.message,
    /Could not write lock .*lifeline-support-.*\.lock: disk full/,
  );
  assert.equal(work.mock.callCount(), 0);
  assert.equal(lockHandle.fd, -1);
  write.mock.restore();
  assert.deepEqual(await withSupportLock(cwd, async () => 'done'), {
    ok: true,
    value: 'done',
  });
});

test('work errors still reject and release the lock', async (t) => {
  const cwd = await makeTempDir();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const failure = new Error('work failed');

  await assert.rejects(
    withSupportLock(cwd, async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.deepEqual(await withSupportLock(cwd, async () => 'done'), {
    ok: true,
    value: 'done',
  });
});

test('holdSupportLock rejects acquired with the lock problem', async (t) => {
  const cwd = await makeTempDir();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const holder = holdSupportLock(cwd);
  await holder.acquired;
  try {
    const contender = holdSupportLock(cwd);
    let problem;
    await assert.rejects(contender.acquired, (error) => {
      problem = error;
      return /Another Lifeline command/.test(error.message);
    });
    assert.deepEqual(await contender.finished, { ok: false, problem });
  } finally {
    holder.release();
    assert.deepEqual(await holder.finished, { ok: true, value: undefined });
  }
});
