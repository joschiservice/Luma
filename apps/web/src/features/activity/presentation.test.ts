import { expect, it } from 'vitest';

import {
  activityChangeLabel,
  activityConnectionOptions,
  activityLabel,
  activityState,
  activitySystemOptions,
  activityTitle,
} from './presentation';

it('reads activity codes as plain labels', () => {
  expect(activityLabel('provider_accepted')).toBe(
    'Accepted by the connected system',
  );
  expect(activityLabel('provider_accepted', 'shopify')).toBe(
    'Accepted by Shopify',
  );
  expect(activityLabel('manually_disposed')).toBe('Closed manually');
  expect(activityLabel('execution.completed')).toBe('Change attempt finished');
  expect(activityLabel('purchase_order.created')).toBe(
    'Purchase order created',
  );
  expect(activityLabel('connection.paused')).toBe('Connection paused');
  expect(activityChangeLabel('orders.shipping-method.write')).toBe(
    'Change the order’s shipping method',
  );
});

it('treats only verified outcomes as confirmed results', () => {
  expect(activityState('verified')).toBe('verified');
  expect(activityState('provider_accepted')).toBe('running');
  expect(activityState('failed')).toBe('error');
});

const sources = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    label: 'Store',
    system: 'shopify',
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    label: 'Outlet',
    system: 'shopify',
  },
  {
    id: '33333333-3333-4333-8333-333333333333',
    label: 'ERP',
    system: 'jtl-cloud',
  },
];

it('offers each connected system once and keeps an applied unknown system', () => {
  expect(activitySystemOptions(sources, undefined)).toEqual([
    { value: 'shopify', label: 'Shopify' },
    { value: 'jtl-cloud', label: 'JTL Cloud' },
  ]);
  expect(activitySystemOptions([], 'legacy').map((o) => o.value)).toEqual([
    'legacy',
  ]);
});

it('names connections and shortens an applied connection that is not listed', () => {
  expect(activityConnectionOptions(sources, sources[0]!.id)).toHaveLength(3);
  expect(
    activityConnectionOptions(
      sources,
      '44444444-4444-4444-8444-444444444444',
    ).at(-1),
  ).toEqual({
    value: '44444444-4444-4444-8444-444444444444',
    label: 'Connection 44444444',
  });
});

it('keeps prose and SKU punctuation while naming capability codes for business events', () => {
  expect(
    activityTitle({
      type: 'verification',
      action: 'execution.completed',
      summary: 'Stock for LS-SAND-M matches JTL-Wawi again.',
    }),
  ).toBe('Stock for LS-SAND-M matches JTL-Wawi again.');
  expect(
    activityTitle({
      type: 'verification',
      action: 'execution.completed',
      summary: 'orders.shipping-method.write',
    }),
  ).toBe('Change the order’s shipping method');
  expect(
    activityTitle({
      type: 'verification',
      action: 'workflow.verification',
      summary: null,
      actor: {
        kind: 'luma',
        id: null,
        name: null,
        email: null,
        workflow: {
          id: 'inventory-replenishment',
          name: 'Replenish low stock',
        },
      },
    }),
  ).toBe('Replenish low stock');
});
