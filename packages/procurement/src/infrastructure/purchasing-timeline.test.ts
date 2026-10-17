import type { SqlTransaction } from '@luma/platform';
import { expect, it } from 'vitest';

import { readPurchasingActionTimeline } from './purchasing-timeline.js';

const createdAt = new Date('2026-10-13T12:00:00.000Z');

/** A transaction whose only stored action is one Shopify stock booking of the order's receipt. */
function booking(details: { quantity: string; unit: string } | null) {
  const calls: { sql: string; values?: unknown[] | undefined }[] = [];
  const query: SqlTransaction['query'] = async <
    Row extends Record<string, unknown>,
  >(
    sql: string,
    values?: unknown[],
  ) => {
    calls.push({ sql, values });
    const rows = sql.includes('FROM shopify_inventory_corrections')
      ? [
          {
            id: 'booking',
            created_at: createdAt,
            action_id: 'action',
            actor_id: details ? 'inventory-lead' : null,
            quantity: details?.quantity ?? null,
            unit: details?.unit ?? null,
          },
        ]
      : [];

    // A test double: the reader names each row's columns in its query.
    return { rows: rows as unknown as Row[], rowCount: rows.length };
  };

  return { query, calls };
}

it('reads stock bookings without their quantity, unit or requester when details are not allowed, and binds every lookup to the tenant', async () => {
  const { query, calls } = booking(null);
  expect(
    await readPurchasingActionTimeline({ query }, 'tenant', 'order', false),
  ).toEqual([
    {
      id: 'stock:booking:requested',
      kind: 'stock_booking',
      stage: 'recorded',
      at: createdAt.toISOString(),
      source: 'inventory',
      actorId: null,
      reason: null,
      evidenceRefs: ['booking'],
      quantity: null,
      unit: null,
      revision: null,
      detail: null,
    },
  ]);
  const stock = calls.find((call) =>
    call.sql.includes('shopify_inventory_corrections'),
  );
  expect(stock?.sql).not.toContain('inventory_snapshots');
  expect(stock?.sql).not.toContain("->>'quantity'");
  expect(stock?.sql).not.toContain('proposedBy');
  for (const call of calls) expect(call.values?.[0]).toBe('tenant');
});

it('reads the booked quantity and unit for inventory readers', async () => {
  const { query } = booking({ quantity: '19', unit: 'pcs' });
  expect(
    await readPurchasingActionTimeline({ query }, 'tenant', 'order', true),
  ).toMatchObject([
    {
      id: 'stock:booking:requested',
      actorId: 'inventory-lead',
      quantity: 19,
      unit: 'pcs',
    },
  ]);
});
