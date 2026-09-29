import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { performanceReport } from '../performance/report.mjs';

test('budget failures retain evidence and reject missing or non-finite measurements', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'luma-performance-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await performanceReport('page', { bytes: 100 }, { bytes: 100 }, directory);
  for (const bytes of [101, NaN, undefined, -1]) {
    await assert.rejects(
      performanceReport('page', { bytes }, { bytes: 100 }, directory),
      /budget failed/,
    );
    const report = JSON.parse(
      await readFile(join(directory, 'page.json'), 'utf8'),
    );
    assert.equal(report.violations.length, 1);
  }
  await assert.rejects(
    performanceReport('../escape', {}, {}, directory),
    /Invalid/,
  );
});
