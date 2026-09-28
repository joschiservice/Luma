import { expect, it } from 'vitest';

import { type CaseMetricItem, summarizeCaseMetrics } from './metrics.js';

const asOf = '2026-09-28T01:00:00.000Z';
const item: CaseMetricItem = {
  kind: 'case',
  id: 'case',
  subjectKind: 'workflow',
  subjectId: 'run',
  state: 'detected',
  title: 'workflow_failure',
  detectedAt: '2026-09-28T00:00:00.000Z',
  ageSeconds: null,
  reason: null,
};
it('counts all subject kinds, excludes resolved issues and preserves exclusive inbox reasons', () => {
  const metrics = summarizeCaseMetrics(
    [
      item,
      ...(['approval', 'manual_intervention', 'uncertainty'] as const).map(
        (reason) => ({ ...item, id: reason, reason }),
      ),
      { ...item, id: 'resolved', state: 'resolved', reason: 'approval' },
    ],
    asOf,
    null,
  );
  expect(metrics.map((m) => m.value)).toEqual([4, 3, 3600]);
  expect(metrics[1]?.breakdown.map((b) => b.count)).toEqual([1, 1, 1]);
  expect(metrics[2]?.nextRefreshAt).toBe('2026-09-28T01:01:00.000Z');
});
it('keeps an empty oldest age null and marks missing or future detection times unknown', () => {
  expect(summarizeCaseMetrics([], asOf, null)[2]).toMatchObject({
    value: null,
    observedCount: 0,
    unknownCount: 0,
  });
  const result = summarizeCaseMetrics(
    [
      item,
      { ...item, id: 'missing', detectedAt: null },
      { ...item, id: 'future', detectedAt: '2026-09-29T00:00:00Z' },
    ],
    asOf,
    null,
  )[2];
  expect(result).toMatchObject({
    value: null,
    unknownCount: 2,
    items: [{ id: 'case', ageSeconds: 3600 }],
  });
});

it('links the actual oldest incident when detection times fall within the same second', () => {
  const metrics = summarizeCaseMetrics(
    [
      { ...item, id: 'a-newer', detectedAt: '2026-09-28T00:00:00.900Z' },
      { ...item, id: 'z-older', detectedAt: '2026-09-28T00:00:00.100Z' },
    ],
    asOf,
    null,
  );
  expect(metrics[2]?.items[0]?.id).toBe('z-older');
  expect(metrics[2]?.value).toBe(3599.9);
});
