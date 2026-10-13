import { describe, expect, it } from 'vitest';

import {
  type OrderChangePlanInput,
  OrderChangeRequestError,
  type PlanAuthority,
  planOrderChanges,
  type PlanSource,
} from './order-change-plan.js';
import type { ComparisonDifference } from './source-comparison.js';

const asOf = '2026-10-12T12:00:00.000Z';
const recent = '2026-10-12T11:59:00.000Z';
const old = '2026-10-12T11:50:00.000Z';
const store = 'store';
const erp = 'erp';
const sku = 'sku-1';

type Work = PlanSource['fulfillments'][number];

function work(
  connection: string,
  status: string,
  quantity = '3',
  overrides: Partial<Work> = {},
): Work {
  return {
    status,
    kind: 'shipment',
    observedAt: recent,
    location: { locationId: 'warehouse' },
    lines: [{ orderLineId: `line-${connection}`, quantity }],
    ...overrides,
  };
}

function source(
  connectionId: string,
  overrides: Partial<PlanSource> = {},
  connection: Partial<PlanSource['connection']> = {},
): PlanSource {
  const shop = connectionId === store;

  return {
    connectionId,
    deleted: false,
    observedAt: recent,
    status: 'open',
    lines: [
      {
        id: `line-${connectionId}`,
        skuId: sku,
        skuCode: 'TOTE-NAT',
        title: 'Canvas tote',
        quantity: '3',
        currentQuantity: '3',
        cancelledQuantity: '0',
        unit: 'each',
      },
    ],
    fulfillments: shop
      ? [
          work(store, 'pending', '3', {
            kind: 'fulfillment_order',
            lines: [
              {
                orderLineId: 'line-store',
                quantity: '3',
                remainingQuantity: '3',
              },
            ],
          }),
        ]
      : [],
    incompleteRead: false,
    externalId: shop ? 'gid://shopify/Order/1' : '1',
    lineRefs: shop
      ? { 'line-store': 'gid://shopify/LineItem/11' }
      : { 'line-erp': '101' },
    connection: {
      category: shop ? 'storefront' : 'erp',
      available: true,
      capabilities: shop
        ? ['orders.read', 'fulfillment.read', 'orders.quantity.edit']
        : ['orders.read', 'fulfillment.read'],
      writeMode: 'writes_enabled',
      access: shop
        ? {
            'orders.quantity.edit': {
              permission: 'shopify:order_edits.apply',
              viewerHas: true,
            },
          }
        : {},
      ...connection,
    },
    ...overrides,
  };
}

const resolved = (
  lines = store,
  fulfillment: string | null = erp,
): PlanAuthority[] => [
  { group: 'order_lines', state: 'resolved', connectionId: lines },
  { group: 'order_lifecycle', state: 'resolved', connectionId: store },
  {
    group: 'order_fulfillment',
    state: fulfillment ? 'resolved' : 'unknown',
    connectionId: fulfillment,
  },
  { group: 'order_tracking', state: 'resolved', connectionId: erp },
];

function input(
  overrides: Partial<OrderChangePlanInput> = {},
): OrderChangePlanInput {
  return {
    sources: [source(store), source(erp)],
    fulfillmentsVisible: true,
    authority: resolved(),
    differences: [],
    comparisonState: 'matching',
    asOf,
    request: { kind: 'quantity', lineKey: sku, quantity: '1' },
    ...overrides,
  };
}

const plan = (overrides: Partial<OrderChangePlanInput> = {}) =>
  planOrderChanges(input(overrides))[0]!;

const codes = (value: ReturnType<typeof plan>) =>
  value.safety.reasons.map((reason) => reason.code);

const steps = (value: ReturnType<typeof plan>) =>
  value.steps.map((step) => [
    step.performer,
    step.action,
    step.role ?? step.blockedBy,
    step.connectionId,
  ]);

describe('order change plans', () => {
  it('offers only authoritative downstream copies through the shipping update capability', () => {
    const shipping = source(
      'shipping',
      {
        lines: [
          {
            id: 'line-shipping',
            skuId: sku,
            quantity: '3',
            currentQuantity: '3',
            cancelledQuantity: '0',
            unit: 'each',
          },
        ],
        externalId: '901',
        lineRefs: { 'line-shipping': '902' },
      },
      {
        category: null,
        capabilities: [
          'orders.read',
          'fulfillment.read',
          'orders.quantity.update',
        ],
        access: {
          'orders.quantity.update': {
            permission: 'starshipit:order_update.run',
            viewerHas: true,
          },
        },
      },
    );
    const authoritative = source(store, {
      lines: [
        {
          id: 'line-store',
          skuId: sku,
          quantity: '3',
          currentQuantity: '2',
          cancelledQuantity: '1',
          unit: 'each',
        },
      ],
    });
    const result = plan({
      sources: [authoritative, shipping],
      authority: resolved(store, store),
      request: { kind: 'quantity', lineKey: sku, quantity: '2' },
    });
    expect(
      result.steps.find(
        (step) =>
          step.connectionId === 'shipping' &&
          step.capability === 'orders.quantity.update',
      ),
    ).toMatchObject({
      performer: 'luma',
      executable: true,
      handoff: {
        orderExternalId: '901',
        lines: [{ externalId: '902', quantity: '2' }],
      },
    });
    const conflicting = plan({
      sources: [authoritative, shipping],
      authority: resolved(store, store),
      request: { kind: 'quantity', lineKey: sku, quantity: '1' },
    });
    expect(
      conflicting.steps.find(
        (step) =>
          step.connectionId === 'shipping' &&
          step.capability === 'orders.quantity.update',
      ),
    ).toMatchObject({ executable: false, blockedBy: 'authority' });
    const owning = plan({
      sources: [authoritative, shipping],
      authority: resolved('shipping', store),
      request: { kind: 'quantity', lineKey: sku, quantity: '2' },
    });
    expect(
      owning.steps.find(
        (step) =>
          step.connectionId === 'shipping' &&
          step.capability === 'orders.quantity.update',
      ),
    ).toMatchObject({ executable: false, blockedBy: 'authority' });
  });
  it('lets Luma reduce a quantity before picking and hands other systems to people', () => {
    const result = plan();
    expect(result.change).toEqual({
      kind: 'quantity',
      origin: 'proposed',
      lineKey: sku,
      line: { skuCode: 'TOTE-NAT', title: 'Canvas tote' },
      from: '3',
      to: '1',
      unit: 'each',
    });
    expect(result.safety).toEqual({ state: 'safe', reasons: [] });
    expect(result.acknowledgements).toEqual([
      {
        connectionId: store,
        state: 'differs',
        value: '3',
        readAt: recent,
        fresh: true,
      },
      {
        connectionId: erp,
        state: 'differs',
        value: '3',
        readAt: recent,
        fresh: true,
      },
    ]);
    expect(result.steps[0]).toMatchObject({
      kind: 'update_record',
      performer: 'luma',
      connectionId: store,
      capability: 'orders.quantity.edit',
      executable: true,
      blockedBy: null,
      permission: 'shopify:order_edits.apply',
      viewerCanRequest: true,
      handoff: {
        orderExternalId: 'gid://shopify/Order/1',
        lines: [{ externalId: 'gid://shopify/LineItem/11', quantity: '1' }],
      },
    });
    expect(steps(result)).toEqual([
      ['luma', 'update_quantity', null, store],
      ['person', 'update_quantity', 'operator', erp],
    ]);
  });

  it('hands the warehouse step to a person once picking started and blocks Luma', () => {
    const result = plan({
      sources: [
        source(store),
        source(erp, { fulfillments: [work(erp, 'processing')] }),
      ],
    });
    expect(result.safety.state).toBe('unsafe');
    expect(result.safety.reasons).toEqual([
      { code: 'work_started', connectionId: erp, lineKey: sku },
    ]);
    expect(steps(result)).toEqual([
      ['person', 'confirm_picking', 'warehouse', erp],
      ['luma', 'update_quantity', 'unsafe', store],
      ['person', 'update_quantity', 'operator', erp],
      ['person', 'escalate_unsafe', 'operator', null],
    ]);
    expect(result.steps[1]!.executable).toBe(false);
  });

  it('treats Shopify in-progress work and failed work as started', () => {
    for (const status of ['processing', 'failed']) {
      const result = plan({
        sources: [
          source(store, {
            fulfillments: [
              work(store, status, '3', { kind: 'fulfillment_order' }),
            ],
          }),
          source(erp),
        ],
      });
      expect(codes(result)).toEqual(['work_started']);
    }
  });

  it('never calls stale, future, incomplete or unknown evidence safe', () => {
    const cases: [Partial<OrderChangePlanInput>, string][] = [
      [
        { sources: [source(store), source(erp, { observedAt: old })] },
        'stale_evidence',
      ],
      [
        {
          sources: [
            source(store),
            source(erp, {
              fulfillments: [work(erp, 'pending', '3', { observedAt: old })],
            }),
          ],
        },
        'stale_evidence',
      ],
      [
        {
          sources: [
            source(store),
            source(erp, { observedAt: '2026-10-12T12:01:00.000Z' }),
          ],
        },
        'stale_evidence',
      ],
      [
        { sources: [source(store), source(erp, { incompleteRead: true })] },
        'incomplete_evidence',
      ],
      [
        {
          sources: [
            source(store),
            source(erp, { fulfillments: [work(erp, 'unknown')] }),
          ],
        },
        'unknown_progress',
      ],
      [{ fulfillmentsVisible: false }, 'fulfilment_hidden'],
      [
        {
          sources: [
            source(
              store,
              { fulfillments: [] },
              { capabilities: ['orders.read'] },
            ),
          ],
          authority: resolved(store, null),
        },
        'no_fulfilment_source',
      ],
    ];
    for (const [overrides, code] of cases) {
      const result = plan(overrides);
      expect(result.safety.state, code).toBe('unknown');
      expect(codes(result), code).toContain(code);
      expect(
        result.steps.some((step) => step.executable),
        code,
      ).toBe(false);
      expect(result.steps.at(-1)?.action).toBe('escalate_unknown');
    }
  });

  it('reports stale systems as unknown acknowledgements and asks a person to check progress', () => {
    const result = plan({
      sources: [source(store), source(erp, { observedAt: old })],
    });
    expect(result.acknowledgements[1]).toMatchObject({
      connectionId: erp,
      state: 'unknown',
      value: '3',
      fresh: false,
    });
    expect(steps(result)[0]).toEqual([
      'person',
      'check_progress',
      'warehouse',
      erp,
    ]);
    expect(result.steps[1]).toMatchObject({
      performer: 'luma',
      executable: false,
      blockedBy: 'unknown',
    });
  });

  it('counts split and partial shipments once per source and never adds mirrors', () => {
    const split = [
      work(store, 'shipped', '1'),
      work(store, 'delivered', '1', { location: { locationId: 'other' } }),
    ];
    const mirrored = [work(erp, 'shipped', '2')];
    const result = plan({
      sources: [
        source(store, { fulfillments: split }),
        source(erp, { fulfillments: mirrored }),
      ],
    });
    expect(result.shipped).toEqual([
      {
        lineKey: sku,
        units: '2',
        unit: 'each',
        basis: 'authority',
        connectionId: erp,
        sources: [
          { connectionId: store, units: '2' },
          { connectionId: erp, units: '2' },
        ],
      },
    ]);
    expect(codes(result)).toEqual(
      expect.arrayContaining(['fulfilled_beyond_target', 'work_started']),
    );
    expect(steps(result)).toContainEqual([
      'person',
      'return_or_refund',
      'finance',
      null,
    ]);

    const unresolved = plan({
      authority: resolved(store, null),
      request: { kind: 'quantity', lineKey: sku, quantity: '2' },
      sources: [
        source(store, { fulfillments: split }),
        source(erp, { fulfillments: [work(erp, 'shipped', '1')] }),
      ],
    });
    expect(unresolved.shipped[0]).toMatchObject({
      units: '2',
      basis: 'maximum',
      connectionId: store,
    });
    expect(codes(unresolved)).not.toContain('fulfilled_beyond_target');
  });

  it('ignores fulfilment work counts, removed records and cancelled work as shipments', () => {
    const result = plan({
      sources: [
        source(store, {
          fulfillments: [
            work(store, 'completed', '3', { kind: 'fulfillment_order' }),
            work(store, 'shipped', '3', { deleted: true }),
            work(store, 'cancelled', '3'),
          ],
        }),
        source(erp),
      ],
    });
    expect(result.shipped[0]).toMatchObject({ units: '0', basis: 'authority' });
    expect(result.safety.state).toBe('safe');
  });

  it('allows an increase after picking started and notifies the warehouse', () => {
    const result = plan({
      request: { kind: 'quantity', lineKey: sku, quantity: '5' },
      sources: [
        source(store),
        source(erp, { fulfillments: [work(erp, 'processing')] }),
      ],
    });
    expect(result.safety.state).toBe('safe');
    expect(steps(result)).toEqual([
      ['luma', 'update_quantity', null, store],
      ['person', 'update_quantity', 'operator', erp],
      ['person', 'notify_added_units', 'warehouse', erp],
    ]);
  });

  it('refuses changes to cancelled or completed orders', () => {
    expect(
      codes(
        plan({
          sources: [source(store, { status: 'cancelled' }), source(erp)],
        }),
      ),
    ).toContain('cancelled');
    expect(
      plan({
        request: { kind: 'quantity', lineKey: sku, quantity: '4' },
        sources: [source(store, { status: 'completed' }), source(erp)],
      }).safety.state,
    ).toBe('unsafe');
  });

  it('needs resolved line authority that reports the order', () => {
    const conflicting = plan({
      authority: resolved().map((item) =>
        item.group === 'order_lines'
          ? { ...item, state: 'conflicting', connectionId: null }
          : item,
      ),
    });
    expect(codes(conflicting)).toContain('authority_conflict');
    expect(conflicting.safety.state).toBe('unknown');
    const missing = plan({ sources: [source(erp)] });
    expect(missing.safety.reasons).toContainEqual({
      code: 'authority_unknown',
      connectionId: store,
      lineKey: null,
    });
  });

  it('explains why a governed Luma step cannot run', () => {
    const blocked = (
      connection: Partial<PlanSource['connection']>,
      overrides: Partial<OrderChangePlanInput> = {},
    ) =>
      plan({
        sources: [source(store, {}, connection), source(erp)],
        ...overrides,
      }).steps.find((step) => step.performer === 'luma')!;
    expect(blocked({ writeMode: 'observe_only' })).toMatchObject({
      blockedBy: 'observe_only',
      executable: false,
    });
    expect(
      blocked({ capabilities: ['orders.read', 'fulfillment.read'] }),
    ).toMatchObject({ blockedBy: 'not_granted' });
    expect(blocked({ available: false })).toMatchObject({
      blockedBy: 'unavailable',
    });
    expect(blocked({}, { authority: resolved(erp) })).toMatchObject({
      blockedBy: 'authority',
    });
    expect(
      blocked(
        {},
        { request: { kind: 'quantity', lineKey: sku, quantity: '1.5' } },
      ),
    ).toMatchObject({ blockedBy: 'whole_units' });
    expect(
      plan({
        sources: [source(store, { lineRefs: {} }), source(erp)],
      }).steps[0],
    ).toMatchObject({ blockedBy: 'unmapped', handoff: null });
    // Permission is the reader's: Luma can run the step, but this person can't request it.
    expect(
      blocked({
        access: {
          'orders.quantity.edit': {
            permission: 'shopify:order_edits.apply',
            viewerHas: false,
          },
        },
      }),
    ).toMatchObject({ executable: true, viewerCanRequest: false });
  });

  it('lets Luma propagate the authoritative quantity to a store that differs', () => {
    const propagate = (erpOverrides: Partial<PlanSource> = {}) =>
      plan({
        authority: resolved(erp),
        request: null,
        comparisonState: 'confirmed',
        differences: [
          {
            field: 'currentQuantity',
            lineKey: sku,
            values: [
              { connectionId: store, value: '3', evidence: [] },
              { connectionId: erp, value: '1', evidence: [] },
            ],
          },
        ],
        sources: [
          source(store),
          source(erp, {
            lines: [{ ...source(erp).lines[0]!, currentQuantity: '1' }],
            ...erpOverrides,
          }),
        ],
      });
    const fresh = propagate();
    expect(fresh.change).toMatchObject({
      origin: 'detected',
      from: '3',
      to: '1',
    });
    expect(fresh.safety.state).toBe('safe');
    expect(fresh.steps).toEqual([
      expect.objectContaining({
        performer: 'luma',
        connectionId: store,
        executable: true,
        blockedBy: null,
        handoff: {
          orderExternalId: 'gid://shopify/Order/1',
          lines: [{ externalId: 'gid://shopify/LineItem/11', quantity: '1' }],
        },
      }),
    ]);

    // An old authoritative read can't establish the value to propagate.
    const stale = propagate({ observedAt: old });
    expect(stale.safety.state).toBe('unknown');
    expect(stale.steps.find((step) => step.performer === 'luma')).toMatchObject(
      {
        connectionId: store,
        executable: false,
        blockedBy: 'unknown',
      },
    );
  });

  it('treats a line removal as a reduction to zero', () => {
    const result = plan({
      request: { kind: 'item', lineKey: sku },
      sources: [
        source(store),
        source(erp, { fulfillments: [work(erp, 'processing')] }),
      ],
    });
    expect(result.change).toMatchObject({ kind: 'item', from: '3', to: '0' });
    expect(codes(result)).toEqual(['work_started']);
  });

  it('cancels only before any work started and routes shipped units to finance', () => {
    const before = plan({ request: { kind: 'cancellation' } });
    expect(before.safety.state).toBe('safe');
    expect(steps(before)).toEqual([
      ['person', 'cancel_order', 'operator', store],
      ['person', 'cancel_order', 'operator', erp],
    ]);
    const shipped = plan({
      request: { kind: 'cancellation' },
      sources: [
        source(store),
        source(erp, {
          fulfillments: [work(erp, 'shipped', '1'), work(erp, 'processing')],
        }),
      ],
    });
    expect(codes(shipped)).toEqual(['work_started', 'shipped']);
    expect(steps(shipped)).toEqual([
      ['person', 'stop_work', 'warehouse', erp],
      ['person', 'return_or_refund', 'finance', null],
      ['person', 'cancel_order', 'operator', store],
      ['person', 'cancel_order', 'operator', erp],
      ['person', 'notify_customer', 'operator', null],
      ['person', 'escalate_unsafe', 'operator', null],
    ]);
  });

  it('changes an address only before work starts and redirects shipped parcels', () => {
    const before = plan({ request: { kind: 'address' } });
    expect(before.safety.state).toBe('safe');
    expect(before.acknowledgements.map((item) => item.state)).toEqual([
      'unknown',
      'unknown',
    ]);
    const packing = plan({
      request: { kind: 'address' },
      sources: [
        source(store),
        source(erp, { fulfillments: [work(erp, 'processing')] }),
      ],
    });
    expect(steps(packing)[0]).toEqual([
      'person',
      'hold_for_address',
      'warehouse',
      erp,
    ]);
    const shipped = plan({
      request: { kind: 'address' },
      sources: [
        source(store),
        source(erp, { fulfillments: [work(erp, 'shipped')] }),
      ],
    });
    expect(codes(shipped)).toEqual(['work_started', 'shipped']);
    expect(steps(shipped)[0]).toEqual([
      'person',
      'carrier_redirect',
      'carrier',
      erp,
    ]);
    expect(steps(shipped)).toContainEqual([
      'person',
      'notify_customer',
      'operator',
      null,
    ]);
  });

  it('reassigns a location only while work there is pending', () => {
    const pending = plan({ request: { kind: 'location', lineKey: sku } });
    expect(pending.safety.state).toBe('safe');
    const started = plan({
      request: { kind: 'location', lineKey: sku },
      sources: [
        source(store),
        source(erp, { fulfillments: [work(erp, 'processing')] }),
      ],
    });
    expect(steps(started)[0]).toEqual([
      'person',
      'stop_and_reassign',
      'warehouse',
      erp,
    ]);
  });

  it('plans detected differences toward the authoritative value', () => {
    const difference = (
      field: ComparisonDifference['field'],
      values: (string | null)[],
      lineKey: string | null = sku,
    ): ComparisonDifference => ({
      field,
      lineKey,
      values: [store, erp].map((connectionId, index) => ({
        connectionId,
        value: values[index] ?? null,
        evidence: [],
      })),
    });
    const edited = {
      sources: [
        source(store, {
          lines: [{ ...source(store).lines[0]!, currentQuantity: '1' }],
        }),
        source(erp),
      ],
      request: null,
      differences: [difference('currentQuantity', ['1', '3'])],
    };
    expect(
      planOrderChanges(input({ ...edited, comparisonState: 'inconclusive' })),
    ).toEqual([]);
    const [detected] = planOrderChanges(
      input({ ...edited, comparisonState: 'confirmed' }),
    );
    expect(detected!.change).toMatchObject({
      kind: 'quantity',
      origin: 'detected',
      from: '3',
      to: '1',
    });
    expect(detected!.acknowledgements.map((item) => item.state)).toEqual([
      'reflects',
      'differs',
    ]);
    expect(steps(detected!)).toEqual([
      ['person', 'update_quantity', 'operator', erp],
    ]);

    const kinds = planOrderChanges(
      input({
        request: null,
        comparisonState: 'pending',
        differences: [
          difference('status', ['cancelled', 'open'], null),
          difference('currentQuantity', ['0', '3']),
          difference('location', ['[["a","3"]]', '[["b","3"]]']),
        ],
      }),
    ).map((item) => item.change.kind);
    expect(kinds).toEqual(['item', 'location', 'cancellation']);
  });

  it('rejects lines that are not on the order and malformed quantities', () => {
    expect(() =>
      plan({ request: { kind: 'quantity', lineKey: 'other', quantity: '1' } }),
    ).toThrow(OrderChangeRequestError);
    expect(() =>
      plan({ request: { kind: 'quantity', lineKey: sku, quantity: '-1' } }),
    ).toThrow(OrderChangeRequestError);
  });
});
