import type { OrderDetail } from '@luma/api-contract';
import { describe, expect, it } from 'vitest';

import { formatMoney, orderLabel, orderSummary } from './presentation';

const source = (
  overrides: Partial<OrderDetail['sources'][number]> = {},
): OrderDetail['sources'][number] => ({
  connectionId: 'shop',
  label: 'Shopify store',
  system: 'shopify',
  connectionStatus: 'active',
  externalId: 'gid://shopify/Order/1',
  selected: true,
  deleted: false,
  observedAt: '2026-09-20T00:00:00.000Z',
  sourceUpdatedAt: '2026-09-20T00:00:00.000Z',
  appId: 'shopify',
  mappingMethod: 'operator-confirmed',
  displayNumber: '#1001',
  status: 'open',
  paymentStatus: 'paid',
  placedAt: null,
  total: null,
  dueAt: null,
  fulfillment: 'partial',
  open: true,
  lines: [
    {
      id: 'line',
      skuId: null,
      skuCode: 'TOTE',
      title: 'Canvas tote',
      quantity: '3',
      cancelledQuantity: '0',
      unit: 'each',
      fulfilledQuantity: '1',
      remainingQuantity: '2',
    },
  ],
  ...overrides,
});

const detail = (
  overrides: Partial<
    Pick<
      OrderDetail,
      'order' | 'sources' | 'differences' | 'fulfillments' | 'issues'
    >
  > = {},
) => ({
  order: {
    id: '0b6f2d0e-3b1f-4a3f-9f7e-6f0f0e4d2a11',
    displayNumber: '#1001',
    placedAt: null,
    total: null,
    status: 'open' as const,
    paymentStatus: 'paid' as const,
    fulfillment: 'partial' as const,
    lineCount: 1,
    open: true,
    overdue: true,
    dueAt: '2026-09-19T00:00:00.000Z',
    issueIds: [],
    differs: false,
    sources: [],
    observedAt: '2026-09-20T00:00:00.000Z',
    sourceUpdatedAt: null,
  },
  sources: [source()],
  differences: [],
  fulfillments: [],
  returns: [],
  issues: [],
  ...overrides,
});

describe('order presentation', () => {
  it('names orders and formats source money', () => {
    expect(orderLabel({ id: 'abcdef123456', displayNumber: null })).toBe(
      'Order abcdef12',
    );
    expect(formatMoney({ amount: '42.5', currency: 'EUR' }, 'en-US')).toBe(
      '€42.50',
    );
    expect(formatMoney({ amount: 'n/a', currency: 'EUR' }, 'en-US')).toBe(
      'n/a EUR',
    );
    expect(formatMoney({ amount: '1234.5', currency: 'EUR' })).toBe(
      '€1,234.50',
    );
    expect(formatMoney(null)).toBeNull();
  });

  it('explains state, remaining work, deadlines, issues and disagreements', () => {
    expect(
      orderSummary(
        detail({
          sources: [
            source(),
            source({
              connectionId: 'erp',
              label: 'JTL-Wawi',
              selected: false,
              paymentStatus: 'pending',
            }),
          ],
          differences: [
            {
              field: 'paymentStatus',
              values: [
                { connectionId: 'shop', value: 'paid' },
                { connectionId: 'erp', value: 'pending' },
              ],
            },
          ],
          issues: [
            {
              id: 'issue',
              class: 'stuck_fulfillment',
              state: 'escalated',
              severity: 'high',
              relationship: 'fulfillment',
              needsYou: true,
              lastDetectedAt: null,
            },
          ],
        }),
        (value) => value.slice(0, 10),
      ),
    ).toEqual([
      {
        kind: 'state',
        text: 'Shopify store reports the order as open. The order is paid.',
      },
      { kind: 'remaining', text: '2 units still to fulfill across 1 line.' },
      {
        kind: 'overdue',
        text: 'Overdue since 2026-09-19.',
      },
      { kind: 'issues', text: '1 issue needs you.' },
      {
        kind: 'differs',
        text: 'Payment differs between sources: “Paid” in Shopify store and “Payment pending” in JTL-Wawi.',
      },
    ]);
  });

  it('says remaining work is unknown instead of guessing cancellations', () => {
    const summary = orderSummary(
      detail({
        sources: [
          source({
            lines: [
              {
                ...source().lines[0]!,
                cancelledQuantity: null,
                remainingQuantity: null,
              },
            ],
          }),
        ],
      }),
      (value) => value,
    );
    expect(summary[0]).toEqual({
      kind: 'unknown',
      text: 'Luma can’t tell how much remains on 1 line because Shopify store doesn’t report canceled quantities. 1 of 3 units are fulfilled.',
    });
  });

  it('leaves one source’s status to the header unless nothing else needs saying', () => {
    const remaining = orderSummary(detail({ sources: [source()] }), String);
    expect(remaining.map((line) => line.kind)).not.toContain('state');

    const settled = orderSummary(
      detail({
        sources: [
          source({
            lines: [{ ...source().lines[0]!, remainingQuantity: '0' }],
          }),
        ],
        order: { ...detail().order, overdue: false },
        issues: [],
      }),
      String,
    );
    expect(settled).toEqual([
      {
        kind: 'state',
        text: 'Shopify store reports the order as open. The order is paid.',
      },
    ]);
  });
});
