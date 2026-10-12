import { describe, expect, it } from 'vitest';

import {
  type JourneyEvent,
  journeyPercentiles,
  journeyTiming,
} from './journey.js';

const event = (
  stage: JourneyEvent['stage'],
  occurredAt: string | null,
  partId = 'shipment-1',
): JourneyEvent => ({
  id: stage,
  orderId: 'order',
  partId,
  orderLineId: 'line',
  stage,
  provenance: 'provider_observation',
  connectionId: 'source',
  actorId: null,
  occurredAt,
  observedAt: '2026-10-13T12:00:00Z',
  quantity: '1',
  unit: 'each',
  references: [],
});

describe('order journey occurrence evidence', () => {
  it('leaves missing occurrence times unknown even when reads have timestamps', () => {
    expect(
      journeyTiming(
        event('paid', null),
        event('reserved', '2026-10-13T10:00:00Z'),
      ).durationMs,
    ).toBeNull();
  });
  it('keeps independent split parts and source mirrors out of duration pairs', () => {
    const from = event('shipped', '2026-10-13T08:00:00Z'),
      to = event('delivered', '2026-10-13T10:00:00Z');
    expect(journeyTiming(from, to).durationMs).toBe(7200000);
    expect(
      journeyTiming(from, { ...to, partId: 'shipment-2' }).durationMs,
    ).toBeNull();
    expect(
      journeyTiming(from, { ...to, connectionId: 'mirror' }).durationMs,
    ).toBeNull();
    expect(
      journeyTiming(from, { ...to, provenance: 'inference' }).durationMs,
    ).toBeNull();
  });
  it('calculates median and p90 from known nonnegative durations', () => {
    expect(journeyPercentiles([10, 20, 30, 40, 50, -1, NaN])).toEqual({
      count: 5,
      medianMs: 30,
      p90Ms: 46,
    });
    expect(journeyPercentiles([])).toEqual({
      count: 0,
      medianMs: null,
      p90Ms: null,
    });
  });
});
