import type { Metrics } from '@luma/simulator-contract';
import { describe, expect, it } from 'vitest';

import {
  bucketStarts,
  bucketValues,
  difference,
  latest,
  meanLatency,
  requestHealth,
  total,
  webhookDelivery,
} from './metrics';

const hour = 3_600_000;
const from = 10 * hour;

const metrics: Metrics = {
  bucketMs: hour,
  from,
  to: from + 3 * hour - 1,
  series: [
    {
      name: 'orders.created',
      instance: 'shop-a',
      points: [
        [from, 4],
        [from + hour, 6],
      ],
    },
    {
      name: 'orders.created',
      instance: 'shop-b',
      points: [[from + 2 * hour, 5]],
    },
    {
      name: 'backlog',
      instance: null,
      points: [
        [from, 10],
        [from + 2 * hour, 7],
        [from + hour, 9],
      ],
    },
    {
      name: 'requests',
      instance: 'jtl',
      points: [
        [from, 100],
        [from + hour, 300],
      ],
    },
    {
      name: 'requests.failed',
      instance: 'jtl',
      points: [
        [from, 5],
        [from + hour, 15],
      ],
    },
    {
      name: 'latency.mean',
      instance: 'jtl',
      points: [
        [from, 100],
        [from + hour, 200],
      ],
    },
    { name: 'requests', instance: 'shop-a', points: [] },
    { name: 'latency.mean', instance: 'shop-a', points: [[from, 50]] },
    { name: 'webhooks.delivered', instance: 'shop-a', points: [[from, 97]] },
    { name: 'webhooks.dropped', instance: 'shop-a', points: [[from, 3]] },
  ],
};

describe('metric aggregation', () => {
  it('covers the window with aligned buckets', () => {
    expect(bucketStarts(metrics)).toEqual([from, from + hour, from + 2 * hour]);
  });

  it('sums counters across instances or for one instance', () => {
    expect(total(metrics, 'orders.created')).toBe(15);
    expect(total(metrics, 'orders.created', 'shop-a')).toBe(10);
    expect(bucketValues(metrics, 'orders.created')).toEqual([4, 6, 5]);
  });

  it('places points into buckets when the window starts mid-bucket', () => {
    const shifted = { ...metrics, from: from + 1_000 };
    expect(bucketValues(shifted, 'orders.created')).toEqual([4, 6, 5]);
  });

  it('reads the newest gauge value regardless of point order', () => {
    expect(latest(metrics, 'backlog')).toBe(7);
    expect(latest(metrics, 'returns.requested')).toBeNull();
  });

  it('computes error rates per instance', () => {
    expect(requestHealth(metrics)).toEqual([
      { instance: 'jtl', requests: 400, failed: 20, errorRate: 0.05 },
      { instance: 'shop-a', requests: 0, failed: 0, errorRate: null },
    ]);
  });

  it('weights latency by request volume and falls back to a plain mean', () => {
    expect(meanLatency(metrics)).toEqual([
      { instance: 'jtl', meanMs: 175 },
      { instance: 'shop-a', meanMs: 50 },
    ]);
  });

  it('reports webhook delivery share', () => {
    expect(webhookDelivery(metrics)).toEqual({
      delivered: 97,
      failed: 0,
      dropped: 3,
      deliveryRate: 0.97,
    });
  });

  it('subtracts aligned series without going negative', () => {
    expect(difference([5, 3], [2, 4])).toEqual([3, 0]);
  });
});
