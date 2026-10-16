import assert from 'node:assert/strict';
import { test } from 'node:test';

import { reviewAdvisories } from './dependency-audit.mjs';

const report = {
  metadata: {},
  advisories: {
    one: {
      github_advisory_id: 'GHSA-aaaa-bbbb-cccc',
      module_name: 'example',
      severity: 'high',
      findings: [{ version: '1.0.0', paths: ['apps>legacy>example'] }],
    },
  },
};
const exception = {
  advisory: 'GHSA-aaaa-bbbb-cccc',
  module: 'example',
  version: '1.0.0',
  dependencyPathSuffix: 'legacy>example',
  reason: 'Affected feature is not used.',
  reviewBy: 'maintainers',
  expires: '2026-11-01',
};
const now = new Date('2026-10-16');

test('fails new advisories and accepts only exact, current reachability reviews', () => {
  assert.equal(reviewAdvisories(report, [], now).length, 1);
  assert.deepEqual(reviewAdvisories(report, [exception], now), []);
  const widened = structuredClone(report);
  widened.advisories.one.findings[0].paths.push('apps>example');
  assert.equal(reviewAdvisories(widened, [exception], now).length, 1);
  assert.equal(
    reviewAdvisories(report, [{ ...exception, version: '2.0.0' }], now).length,
    1,
  );
  assert.equal(
    reviewAdvisories(report, [{ ...exception, expires: '2026-10-01' }], now)
      .length,
    2,
  );
  assert.equal(
    reviewAdvisories(report, [{ ...exception, expires: 'invalid' }], now)
      .length,
    2,
  );
});

test('fails closed on registry and malformed-report errors', () => {
  assert.throws(() =>
    reviewAdvisories({ error: 'registry unavailable' }, [], now),
  );
});
