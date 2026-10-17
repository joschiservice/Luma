import { randomUUID } from 'node:crypto';

import {
  builtInMembership,
  makeTenantContext,
  PermissionSet,
} from '@luma/identity';
import type { SqlTransaction, TenantDatabase } from '@luma/platform';
import { describe, expect, it } from 'vitest';

import { createPurchaseReceiptStages } from './purchase-receipt-stages.js';

const tenantId = randomUUID(),
  orderId = randomUUID(),
  sku = randomUUID(),
  location = randomUUID(),
  available = randomUUID(),
  damaged = randomUUID(),
  entryId = randomUUID(),
  reviewed = new Date('2026-10-13T12:00:00.000Z'),
  readAt = new Date('2026-10-13T13:00:00.000Z');

function context(permissions: string[]) {
  const membership = builtInMembership(
    { id: randomUUID(), organizationId: tenantId, userId: 'reader' },
    'owner',
  );

  return makeTenantContext(
    { userId: 'reader', sessionId: randomUUID() },
    {
      id: tenantId,
      name: 'Shop',
      slug: 'shop',
      dataRegion: 'EU',
      status: 'active',
    },
    { ...membership, permissions: new PermissionSet(permissions) },
    randomUUID(),
  );
}

/** A receipt as Inventory stored it when the booking committed. */
const receipt = (accounts: { id: string; balance: string }[]) => ({
  id: randomUUID(),
  key: `purchase-receipt:${orderId}`,
  commandHash: 'b'.repeat(64),
  entryId,
  reviewId: null,
  recordedAt: reviewed.toISOString(),
  accounts: accounts.map((account) => ({
    id: account.id,
    address: {
      skuId: sku,
      locationId: location,
      unit: 'each',
      state: account.id === available ? 'available' : 'damaged',
    },
    balance: account.balance,
    version: '1',
  })),
});

/** A database holding one order's pending, rejected and two approved receipt reviews. */
function database(currentAvailable: string) {
  const calls: { tenantId: string; sql: string; values?: unknown[] }[] = [];
  let readOnly = false;
  const db: TenantDatabase = {
    async transaction(tenant, operation, options) {
      readOnly = !!options?.readOnlySnapshot;
      const tx: SqlTransaction = {
        query: async <Row extends Record<string, unknown>>(
          sql: string,
          values?: unknown[],
        ) => {
          calls.push({ tenantId: tenant, sql, values });
          const rows = sql.includes('FROM inventory_ledger_reviews')
            ? [
                {
                  id: 'waiting',
                  state: 'pending',
                  at: reviewed,
                  receipt: null,
                },
                {
                  id: 'refused',
                  state: 'rejected',
                  at: reviewed,
                  receipt: null,
                },
                // Approved but not posted yet.
                {
                  id: 'approved',
                  state: 'approved',
                  at: reviewed,
                  receipt: null,
                },
                {
                  id: 'booked',
                  state: 'approved',
                  at: reviewed,
                  receipt: receipt([
                    { id: available, balance: '38' },
                    { id: damaged, balance: '2' },
                  ]),
                },
              ]
            : [
                { id: available, balance: currentAvailable, version: '1' },
                { id: damaged, balance: '2', version: '1' },
              ];

          // A test double: the query names each row's columns.
          return { rows: rows as unknown as Row[], rowCount: rows.length };
        },
      };

      return operation(tx);
    },
  };

  return { db, calls, readOnly: () => readOnly };
}

describe('purchase receipt stages', () => {
  it('lists each review with only its stage, time and ledger readback', async () => {
    const { db, calls, readOnly } = database('38');
    const stages = await createPurchaseReceiptStages(db, () => readAt)(
      context(['procurement.read']),
      orderId,
    );

    expect(stages).toEqual([
      {
        reviewId: 'waiting',
        state: 'pending',
        at: reviewed.toISOString(),
        verification: null,
      },
      {
        reviewId: 'refused',
        state: 'rejected',
        at: reviewed.toISOString(),
        verification: null,
      },
      {
        reviewId: 'approved',
        state: 'approved',
        at: reviewed.toISOString(),
        verification: null,
      },
      {
        reviewId: 'booked',
        state: 'approved',
        at: reviewed.toISOString(),
        verification: {
          outcome: 'verified',
          observedAt: readAt.toISOString(),
        },
      },
    ]);
    const shown = JSON.stringify(stages);
    for (const hidden of [sku, location, available, damaged, entryId, '38'])
      expect(shown).not.toContain(hidden);
    expect(readOnly()).toBe(true);
    for (const call of calls) {
      expect(call.tenantId).toBe(tenantId);
      expect(call.values?.[0]).toBe(tenantId);
    }
    expect(calls[0]?.values).toEqual([tenantId, orderId]);
  });

  it('reports a booking whose accounts changed since as inconclusive', async () => {
    const { db } = database('41');
    const stages = await createPurchaseReceiptStages(db, () => readAt)(
      context(['procurement.read']),
      orderId,
    );

    expect(stages.find((stage) => stage.reviewId === 'booked')).toMatchObject({
      verification: { outcome: 'inconclusive' },
    });
  });

  it('refuses a reader without procurement access before reading anything', async () => {
    const { db, calls } = database('38');

    await expect(
      createPurchaseReceiptStages(db)(context(['inventory.read']), orderId),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(calls).toEqual([]);
  });
});
