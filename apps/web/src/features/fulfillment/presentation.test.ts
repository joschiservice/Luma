import type { FulfillmentDetail, FulfillmentItem } from '@luma/api-contract';
import { expect, it } from 'vitest';

import { fulfillmentListQuery } from './data';
import {
  duration,
  fulfillmentReason,
  fulfillmentState,
  lastChange,
  nextStep,
  otherSignals,
  quantity,
  shippingFreshness,
  timelineChanges,
} from './presentation';

const asOf = '2026-09-30T12:00:00.000Z';

const item = (patch: Partial<FulfillmentItem> = {}): FulfillmentItem => ({
  id: '5b1d7f9e-3c2a-4d6b-9e8f-1a2b3c4d5e6f',
  connectionId: '0c9d8e7f-6a5b-4c3d-8e2f-1a0b9c8d7e6f',
  externalId: 'gid://shopify/FulfillmentOrder/200',
  kind: 'fulfillment_order',
  status: 'pending',
  deleted: false,
  open: true,
  signals: [],
  holds: [],
  location: { id: null, name: 'Tokyo warehouse' },
  method: { type: 'shipping', name: 'Express' },
  fulfillAt: null,
  fulfillBy: null,
  estimatedDeliveryAt: null,
  lastProgressAt: '2026-09-30T10:00:00.000Z',
  progressAt: '2026-09-30T10:00:00.000Z',
  delivery: null,
  failureCode: null,
  tracking: [],
  units: '2',
  unit: 'each',
  order: {
    id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
    number: '#200',
    status: 'open',
    placedAt: null,
  },
  observedAt: '2026-09-30T11:00:00.000Z',
  sourceUpdatedAt: '2026-09-30T10:00:00.000Z',
  ...patch,
});

const source = {
  connectionId: '0c9d8e7f-6a5b-4c3d-8e2f-1a0b9c8d7e6f',
  label: 'Tokyo store',
  system: 'shopify',
  status: 'active',
  appId: 'shopify',
};

it('separates stale reads from quiet carrier progress and keeps label handoffs unknown', () => {
  const shipping = {
    stage: 'carrier' as const,
    sourceUrl: null,
    trackingUpdatedAt: '2026-09-28T12:00:00.000Z',
  };
  expect(shippingFreshness(item({ shipping, observedAt: asOf }), asOf)).toEqual(
    { staleRead: false, quietTracking: true },
  );
  expect(shippingFreshness(item({ shipping }), asOf)).toEqual({
    staleRead: true,
    quietTracking: true,
  });
  expect(
    shippingFreshness(
      item({
        shipping: { ...shipping, stage: 'unknown' },
        delivery: 'label_created',
      }),
      asOf,
    ),
  ).toEqual({ staleRead: true, quietTracking: false });
  expect(
    shippingFreshness(
      item({ shipping: { ...shipping, stage: 'delivered' } }),
      asOf,
    ).quietTracking,
  ).toBe(false);
  expect(shippingFreshness(item(), asOf)).toEqual({
    staleRead: false,
    quietTracking: false,
  });
  const ambiguous = item({
    shipping: { ...shipping, stage: 'unknown' },
    delivery: 'label_created',
  });
  expect(
    nextStep({ item: ambiguous, source, stalledAfterHours: 48 }, false),
  ).toMatchObject({ title: 'Confirm the shipment handoff' });
});

it('names the most urgent state and keeps other signals as badges', () => {
  const held = item({
    signals: ['held', 'overdue'],
    holds: ['incorrect_address'],
    fulfillBy: '2026-09-30T06:00:00.000Z',
  });
  expect(fulfillmentState(held)).toMatchObject({
    state: 'attention',
    label: 'On hold',
  });
  expect(otherSignals(held)).toEqual(['overdue']);
  expect(fulfillmentReason(held, asOf)).toBe('Held: Incorrect address.');
  expect(
    fulfillmentState(item({ signals: ['held', 'failed'], status: 'failed' })),
  ).toMatchObject({ state: 'error', label: 'Failed' });
  expect(fulfillmentState(item({ deleted: true, signals: [] }))).toEqual({
    state: 'idle',
    label: 'Removed at source',
  });
  expect(
    fulfillmentState(
      item({ kind: 'shipment', status: 'delivered', open: false }),
    ),
  ).toEqual({ state: 'verified', label: 'Delivered' });
});

it('explains delays with durations and shipments with tracking', () => {
  expect(duration(3 * 86_400_000 + 5000)).toBe('3 days');
  expect(duration(47 * 3_600_000)).toBe('47 hours');
  expect(duration(1000)).toBe('1 minute');
  expect(
    fulfillmentReason(
      item({
        signals: ['stalled'],
        status: 'processing',
        progressAt: '2026-09-27T12:00:00.000Z',
      }),
      asOf,
    ),
  ).toBe('No progress for 3 days.');
  const shipped = item({
    kind: 'shipment',
    status: 'shipped',
    open: false,
    tracking: [{ carrier: 'Yamato', number: '4521', url: null }],
  });
  expect(fulfillmentReason(shipped, asOf)).toBe('Yamato 4521');
  expect(
    fulfillmentReason(
      {
        ...shipped,
        signals: ['delivery_issue'],
        delivery: 'attempted_delivery',
      },
      asOf,
    ),
  ).toBe('Delivery attempted · 4521.');
});

it('offers a release only for held work the source app can act on', () => {
  const held = item({ signals: ['held'], holds: ['incorrect_address'] });
  const detail = { item: held, source, stalledAfterHours: 48 };
  expect(nextStep(detail, true)).toMatchObject({
    title: 'Resolve the hold reason, then release the hold',
    action: 'release',
  });
  expect(nextStep(detail, true).body).toContain(
    'Confirm the shipping address with the customer',
  );
  expect(nextStep(detail, true).body).toContain('fewer units remaining');
  expect(nextStep(detail, false)).toMatchObject({
    title: 'Resolve the hold in Tokyo store',
    action: 'none',
  });
  // A method correction is explicitly not progress.
  expect(
    nextStep({ ...detail, item: item({ signals: ['stalled'] }) }, false).body,
  ).toContain('doesn’t prove that it shipped');
  expect(
    nextStep(
      {
        ...detail,
        item: item({
          kind: 'shipment',
          status: 'shipped',
          open: false,
          signals: ['late_delivery'],
          tracking: [{ carrier: 'DHL', number: '1', url: 'https://t.test/1' }],
        }),
      },
      false,
    ),
  ).toMatchObject({ title: 'Check the shipment with DHL', action: 'carrier' });
});

it('describes what changed between reads and finds the last change', () => {
  const entry = (
    patch: Partial<FulfillmentDetail['timeline']['entries'][number]>,
  ) => ({
    snapshotId: crypto.randomUUID(),
    current: false,
    deleted: false,
    observedAt: '2026-09-30T08:00:00.000Z',
    sourceUpdatedAt: null,
    status: 'pending' as const,
    holds: [],
    delivery: null,
    lastProgressAt: null,
    locationName: 'Tokyo warehouse',
    fulfillBy: null,
    ...patch,
  });
  const entries = [
    entry({ current: true, holds: [], status: 'processing' }),
    entry({ holds: ['incorrect_address'] }),
    entry({ holds: ['incorrect_address'] }),
    entry({}),
  ];
  expect(timelineChanges(entries)).toEqual([
    ['Waiting to start → In progress', 'Holds released'],
    [],
    ['Hold added: Incorrect address'],
    ['First read: Waiting to start'],
  ]);
  expect(
    lastChange({ timeline: { entries, truncated: false } })?.changes,
  ).toEqual(['Waiting to start → In progress', 'Holds released']);
});

it('opens on the attention view with the longest wait first', () => {
  expect(fulfillmentListQuery({})).toEqual({
    q: '',
    view: 'attention',
    connectionId: undefined,
    locationId: undefined,
    kind: undefined,
    sort: 'waiting',
    cursor: undefined,
  });
});

it('names piece units in the interface language and keeps other units', () => {
  expect(quantity('1', 'each')).toBe('1 unit');
  expect(quantity('12', 'EACH')).toBe('12 units');
  expect(quantity('3', 'Stk')).toBe('3 units');
  expect(quantity('1.5', 'kg')).toBe('1.5 kg');
  expect(quantity('2', null)).toBe('2 units');
});
