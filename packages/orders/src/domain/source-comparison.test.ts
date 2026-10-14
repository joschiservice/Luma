import { describe, expect, it } from 'vitest';

import {
  compareOrderSources,
  comparisonFacts,
  type ComparisonFulfillment,
  type ComparisonSource,
  orderComparisonState,
} from './source-comparison.js';

const start = '2026-10-10T12:00:00Z';
const afterGrace = '2026-10-10T12:15:00Z';

function source(connectionId: string, current = '2'): ComparisonSource {
  return {
    connectionId,
    snapshotId: `snapshot-${connectionId}`,
    observationId: `observation-${connectionId}`,
    observedAt: start,
    status: 'open',
    paymentStatus: 'paid',
    lines: [
      {
        id: `line-${connectionId}`,
        skuId: 'sku',
        quantity: '2',
        currentQuantity: current,
        cancelledQuantity: String(2 - Number(current)),
        unit: 'each',
      },
    ],
    fulfillments: [],
  };
}

function shipment(
  id: string,
  connection: string,
  quantity: string,
  location = 'a',
): ComparisonFulfillment {
  return {
    snapshotId: id,
    observationId: `read-${id}`,
    observedAt: start,
    kind: 'shipment',
    status: 'shipped',
    location: { locationId: location },
    lines: [{ orderLineId: `line-${connection}`, quantity }],
  };
}

describe('order source business comparison', () => {
  it('compares commercial quantities while unmatched partial shipping items stay unreported', () => {
    const shipping: ComparisonSource = {
      ...source('shipping'),
      lineCoverage: 'partial',
      status: 'unknown',
      paymentStatus: 'unknown',
      lines: [{ ...source('shipping').lines[0]!, skuId: null }],
    };
    const result = compareOrderSources([
      source('shop'),
      source('erp', '1'),
      shipping,
    ]);
    expect(result.incomplete).toBe(false);
    expect(
      result.differences.find((item) => item.field === 'currentQuantity'),
    ).toMatchObject({
      lineKey: 'sku',
      values: [{ value: '2' }, { value: '1' }, { value: null }],
    });
    expect(
      compareOrderSources([
        source('shop'),
        { ...shipping, lineCoverage: 'complete' },
      ]).incomplete,
    ).toBe(true);
  });
  it('uses an explicitly matched partial item without inferring zero for its missing lines', () => {
    const shop = source('shop');
    const shipping: ComparisonSource = {
      ...source('shipping'),
      lineCoverage: 'partial',
      lines: [{ ...shop.lines[0]!, skuId: null }],
    };
    const result = compareOrderSources([shop, source('erp', '1'), shipping]);
    expect(result.incomplete).toBe(false);
    expect(
      result.differences.filter((item) => item.field === 'currentQuantity'),
    ).toEqual([
      expect.objectContaining({
        lineKey: 'line-shop',
        values: expect.arrayContaining([
          expect.objectContaining({ connectionId: 'erp', value: '1' }),
          expect.objectContaining({ connectionId: 'shipping', value: '2' }),
        ]),
      }),
    ]);
    expect(
      compareOrderSources([
        source('shop'),
        source('erp', '1'),
        { ...shipping, lines: [] },
      ]).differences.find((item) => item.field === 'currentQuantity')?.values[2]
        ?.value,
    ).toBeNull();
  });
  it('matches a line two sources share with a third source that reports it under its own ID by SKU', () => {
    const store = source('store');
    // A Luma record copies the store's canonical line; the ERP imports it as its own line.
    const record = {
      ...source('record', '1'),
      lines: [{ ...source('record', '1').lines[0]!, id: 'line-store' }],
    };
    const erp = {
      ...source('erp'),
      lines: [
        {
          ...source('erp').lines[0]!,
          currentQuantity: null,
          cancelledQuantity: null,
        },
      ],
    };
    const result = compareOrderSources([store, record, erp]);
    expect(result.incomplete).toBe(false);
    expect(
      result.differences
        .filter((difference) => difference.field === 'currentQuantity')
        .map((difference) => [
          difference.lineKey,
          difference.values.map((value) => value.value),
        ]),
    ).toEqual([['line-store', ['2', '1', null]]]);

    // A SKU on two shared lines identifies neither.
    const twice = {
      ...store,
      lines: [
        ...store.lines,
        { ...store.lines[0]!, id: 'line-store-2', currentQuantity: '2' },
      ],
    };
    expect(
      compareOrderSources([twice, { ...record, lines: twice.lines }, erp])
        .incomplete,
    ).toBe(true);
  });

  it('keeps a reduction pending until both sources are reread after grace, then confirms', () => {
    const a = source('store', '1'),
      b = source('erp');
    const result = compareOrderSources([a, b]);
    expect(result.differences.map((d) => d.field)).toEqual([
      'currentQuantity',
      'cancelledQuantity',
      'remainingQuantity',
    ]);
    expect(result.differences[0]).toMatchObject({
      lineKey: 'sku',
      values: [
        {
          connectionId: 'store',
          value: '1',
          evidence: [{ observationId: 'observation-store', observedAt: start }],
        },
        { connectionId: 'erp', value: '2' },
      ],
    });
    expect(
      orderComparisonState('different', start, start, afterGrace, start),
    ).toBe('pending');
    expect(
      orderComparisonState(
        'different',
        '2026-10-10T12:14:00Z',
        afterGrace,
        afterGrace,
        afterGrace,
      ),
    ).toBe('pending');
    expect(
      orderComparisonState(
        'different',
        afterGrace,
        afterGrace,
        afterGrace,
        afterGrace,
      ),
    ).toBe('confirmed');
  });
  it('compares split shipments by mapped location allocation and never adds mirrored sources', () => {
    const a = source('store'),
      b = source('erp');
    a.fulfillments = [
      shipment('s1', 'store', '1', 'a'),
      shipment('s2', 'store', '1', 'b'),
    ];
    b.fulfillments = [
      shipment('e2', 'erp', '1', 'b'),
      shipment('e1', 'erp', '1', 'a'),
    ];
    expect(compareOrderSources([a, b])).toEqual({
      differences: [],
      incomplete: false,
    });
    expect(comparisonFacts(a, new Set()).lines[0]?.fulfilledQuantity).toBe('2');
  });
  it('detects a location move without changing quantities', () => {
    const a = source('store'),
      b = source('erp');
    a.fulfillments = [shipment('s1', 'store', '2', 'a')];
    b.fulfillments = [shipment('e1', 'erp', '2', 'b')];
    expect(compareOrderSources([a, b]).differences.map((d) => d.field)).toEqual(
      ['location'],
    );
  });
  it('records excess shipped units as overfulfillment even for one source', () => {
    const a = source('store', '1');
    a.fulfillments = [
      shipment('s1', 'store', '1'),
      shipment('s2', 'store', '1'),
    ];
    expect(compareOrderSources([a]).differences).toMatchObject([
      {
        field: 'overfulfillment',
        lineKey: 'sku',
        values: [
          {
            value: '1',
            evidence: [{}, { snapshotId: 's1' }, { snapshotId: 's2' }],
          },
        ],
      },
    ]);
  });
  it('keeps labels without dispatch evidence unshipped and excludes completed work', () => {
    const a = source('store');
    a.fulfillments = [
      { ...shipment('label', 'store', '2'), status: 'processing' },
      {
        ...shipment('work', 'store', '2'),
        status: 'completed',
        kind: 'fulfillment_order',
      },
    ];
    expect(comparisonFacts(a, new Set()).lines[0]).toMatchObject({
      fulfilledQuantity: '0',
      remainingQuantity: '2',
      fulfillment: 'unfulfilled',
    });
  });
  it('makes stale, future, ambiguous and incomplete reads inconclusive', () => {
    expect(
      orderComparisonState(
        'different',
        start,
        afterGrace,
        afterGrace,
        afterGrace,
      ),
    ).toBe('inconclusive');
    expect(
      orderComparisonState('matching', start, afterGrace, null, start),
    ).toBe('inconclusive');
    expect(
      orderComparisonState('inconclusive', start, start, null, start),
    ).toBe('inconclusive');
    const a = source('store'),
      b = source('erp');
    a.lines.push({ ...a.lines[0]!, id: 'another-line', quantity: '1' });
    expect(compareOrderSources([a, b]).incomplete).toBe(true);
  });
  it('does not collapse repeated SKU lines with explicit line mappings', () => {
    const a = source('store'),
      b = source('erp');
    a.lines = [
      { ...a.lines[0]!, id: 'shared-1' },
      {
        ...a.lines[0]!,
        id: 'shared-2',
        currentQuantity: '1',
        cancelledQuantity: '1',
      },
    ];
    b.lines = [
      {
        ...b.lines[0]!,
        id: 'shared-1',
        currentQuantity: '1',
        cancelledQuantity: '1',
      },
      { ...b.lines[0]!, id: 'shared-2' },
    ];
    expect(
      compareOrderSources([a, b])
        .differences.filter((d) => d.field === 'currentQuantity')
        .map((d) => d.lineKey),
    ).toEqual(['shared-1', 'shared-2']);
  });
  it('preserves unknown reductions and compares decimal quantities exactly', () => {
    const a = source('store'),
      b = source('erp');
    a.lines[0] = {
      ...a.lines[0]!,
      quantity: '99999999999999.000001',
      currentQuantity: '99999999999999.000001',
      cancelledQuantity: null,
    };
    b.lines[0] = {
      ...b.lines[0]!,
      quantity: '99999999999999.000002',
      currentQuantity: null,
      cancelledQuantity: null,
    };
    expect(compareOrderSources([a, b]).differences.map((d) => d.field)).toEqual(
      ['orderedQuantity'],
    );
    expect(
      comparisonFacts(b, new Set()).lines[0]?.remainingQuantity,
    ).toBeNull();
  });
});
