import assert from 'node:assert/strict';
import { test } from 'node:test';

import { benchmarkPlan } from '../benchmarks/plan.mjs';

test('benchmarks forward worker limits to the correct runner', () => {
  assert.equal(
    benchmarkPlan(['--suite', 'browser', '--workers', '3']).command,
    'pnpm test:browser --workers=3',
  );
  assert.equal(
    benchmarkPlan(['--suite', 'e2e', '--workers', '2']).command,
    'pnpm test:e2e --maxWorkers=2',
  );
  assert.equal(benchmarkPlan(['--warmup', '0']).warmup, 0);
});

test('benchmarks reject invalid measurements and unsafe command or artifact inputs', () => {
  for (const args of [
    ['--runs', '0'],
    ['--warmup', '-1'],
    ['--workers', '1;exit'],
    ['--suite', 'full', '--workers', '2'],
    ['--suite', 'toString'],
    ['--label', '../escape'],
    ['--suite', 'echo hello'],
    ['--unknown'],
  ])
    assert.throws(() => benchmarkPlan(args));
});
