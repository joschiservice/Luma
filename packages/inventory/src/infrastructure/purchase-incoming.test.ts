import { createHash, randomUUID } from 'node:crypto';

import { builtInMembership, makeTenantContext } from '@luma/identity';
import { canonicalJson } from '@luma/platform';
import { describe, expect, it } from 'vitest';

import type { LedgerReceipt } from '../application/ledger.js';
import {
  createPurchaseIncoming,
  type PurchaseIncomingRecord,
  type PurchaseIncomingSource,
  type PurchaseIncomingStore,
} from '../application/purchase-incoming.js';
import {
  accountKey,
  type LedgerAccount,
  planPostings,
} from '../domain/ledger.js';

function fixture() {
  const tenantId = randomUUID(),
    orderId = randomUUID(),
    skuId = randomUUID(),
    locationId = randomUUID(),
    lineId = randomUUID(),
    userId = randomUUID();
  const context = makeTenantContext(
    { userId, sessionId: randomUUID() },
    {
      id: tenantId,
      name: 'Shop',
      slug: 'shop',
      dataRegion: 'EU',
      status: 'active',
    },
    builtInMembership(
      { id: randomUUID(), organizationId: tenantId, userId },
      'owner',
    ),
    randomUUID(),
  );
  const accounts = new Map<string, LedgerAccount>();
  const receipts = new Map<string, LedgerReceipt>();
  const records: PurchaseIncomingRecord[] = [];
  let booked = '0',
    enabled = true,
    opened = true;
  let source: PurchaseIncomingSource = {
    complete: true,
    revision: 'a'.repeat(64),
    evidenceRefs: [randomUUID()],
    lines: [
      {
        lineId,
        skuId,
        locationId,
        unit: 'each',
        expectedQuantity: '100',
        scopeVersion: '3',
        observedAt: '2026-10-13T12:00:00.000Z',
        expectedDate: '2026-10-16',
        dateConfidence: 'requested',
      },
    ],
  };
  const store: PurchaseIncomingStore = {
    transaction: async (ctx, order, operation) => {
      if (ctx.tenantId !== tenantId || order !== orderId)
        throw Error('Tenant has no incoming records');

      return operation({
        source: async () => source,
        records: async () => records,
        booked: async () => booked,
        save: async (record) => {
          const index = records.findIndex(
            (value) => value.lineId === record.lineId,
          );
          if (index < 0) records.push(record);
          else records[index] = record;
        },
        ledger: {
          opened: async () => opened,
          lockCommand: async () => {},
          receipt: async (key) => receipts.get(key) ?? null,
          accounts: async (addresses) =>
            addresses.map((address) => {
              const key = accountKey(address);
              let account = accounts.get(key);
              if (!account) {
                account = {
                  id: randomUUID(),
                  address,
                  balance: '0',
                  version: '0',
                };
                accounts.set(key, account);
              }

              return account;
            }),
          commit: async (command, hash, current, reviewId) => {
            const changes = planPostings(command, current);
            const next = changes.map((value) => ({
              id: value.accountId,
              address: value.address,
              balance: value.balance,
              version: value.version,
            }));
            for (const account of next)
              accounts.set(accountKey(account.address), account);
            const result: LedgerReceipt = {
              id: command.id,
              key: command.key,
              commandHash: hash,
              entryId: command.id,
              reviewId,
              recordedAt: '2026-10-13T12:00:00.000Z',
              accounts: next,
            };
            receipts.set(command.key, result);

            return result;
          },
        },
      });
    },
  };
  const hash = (value: unknown) =>
    createHash('sha256').update(canonicalJson(value)).digest('hex');
  const service = createPurchaseIncoming({
    store,
    refreshContext: async (ctx) => ctx,
    enabled: async () => enabled,
    hash,
    uuid: () => randomUUID(),
  });
  const balance = (state: LedgerAccount['address']['state']) =>
    [...accounts.values()].find((value) => value.address.state === state)
      ?.balance ?? '0';

  return {
    service,
    context,
    orderId,
    accounts,
    records,
    receipts,
    balance,
    source: (value: PurchaseIncomingSource) => {
      source = value;
    },
    current: () => source,
    enable: (value: boolean) => {
      enabled = value;
    },
    opening: (value: boolean) => {
      opened = value;
    },
    book: (quantity: string) => {
      booked = quantity;
      const record = records[0]!;
      record.outstandingQuantity = String(
        Number(record.expectedQuantity) - Number(quantity),
      );
      const incoming = [...accounts.values()].find(
        (value) => value.address.state === 'incoming',
      )!;
      incoming.balance = record.outstandingQuantity;
      incoming.version = String(Number(incoming.version) + 1);
    },
  };
}

describe('native supplier incoming projection', () => {
  it('appends only balanced incoming expectations and retains exact retry results', async () => {
    const f = fixture();
    expect(await f.service.reconcile(f.context, f.orderId)).toEqual({
      updated: 1,
      unavailable: [],
    });
    expect(f.balance('incoming')).toBe('100');
    expect(f.balance('supplier')).toBe('-100');
    expect(f.balance('available')).toBe('0');
    expect(await f.service.reconcile(f.context, f.orderId)).toEqual({
      updated: 0,
      unavailable: [],
    });
    expect(f.receipts.size).toBe(1);
    f.source({
      ...f.current(),
      revision: 'b'.repeat(64),
      lines: f.current().lines.map((line) => ({
        ...line,
        expectedQuantity: '70',
        dateConfidence: 'confirmed',
      })),
    });
    await f.service.reconcile(f.context, f.orderId);
    expect(f.balance('incoming')).toBe('70');
    expect(f.balance('available')).toBe('0');
  });
  it('subtracts booked receipts and releases cancelled expectations without booking stock twice', async () => {
    const f = fixture();
    await f.service.reconcile(f.context, f.orderId);
    f.book('40');
    expect(await f.service.reconcile(f.context, f.orderId)).toEqual({
      updated: 0,
      unavailable: [],
    });
    expect(f.balance('incoming')).toBe('60');
    f.source({
      ...f.current(),
      revision: 'c'.repeat(64),
      lines: f
        .current()
        .lines.map((line) => ({ ...line, expectedQuantity: '70' })),
    });
    await f.service.reconcile(f.context, f.orderId);
    expect(f.balance('incoming')).toBe('30');
    f.source({
      ...f.current(),
      revision: 'd'.repeat(64),
      lines: f
        .current()
        .lines.map((line) => ({ ...line, expectedQuantity: '0' })),
    });
    await f.service.reconcile(f.context, f.orderId);
    expect(f.balance('incoming')).toBe('0');
  });
  it('deduplicates cumulative provider receipts against native booked receipts', async () => {
    const f = fixture();
    await f.service.reconcile(f.context, f.orderId);
    f.book('40');
    f.source({
      ...f.current(),
      revision: 'e'.repeat(64),
      lines: f
        .current()
        .lines.map((line) => ({ ...line, providerReceivedQuantity: '40' })),
    });
    await f.service.reconcile(f.context, f.orderId);
    expect(f.balance('incoming')).toBe('60');
    f.source({
      ...f.current(),
      revision: 'f'.repeat(64),
      lines: f
        .current()
        .lines.map((line) => ({ ...line, providerReceivedQuantity: '70' })),
    });
    await f.service.reconcile(f.context, f.orderId);
    expect(f.balance('incoming')).toBe('30');
    expect(f.balance('available')).toBe('0');
  });
  it('retains expectations on incomplete evidence and reports unavailable openings', async () => {
    const f = fixture();
    await f.service.reconcile(f.context, f.orderId);
    f.source({ ...f.current(), complete: false, lines: [] });
    expect(await f.service.reconcile(f.context, f.orderId)).toEqual({
      updated: 0,
      unavailable: [f.orderId],
    });
    expect(f.balance('incoming')).toBe('100');
    const missing = fixture();
    missing.opening(false);
    expect(
      (await missing.service.reconcile(missing.context, missing.orderId))
        .unavailable,
    ).toHaveLength(1);
    expect(missing.receipts.size).toBe(0);
  });
  it('refuses changed ownership and does not post when the release is off', async () => {
    const f = fixture();
    f.enable(false);
    expect((await f.service.reconcile(f.context, f.orderId)).updated).toBe(0);
    expect(f.receipts.size).toBe(0);
    f.enable(true);
    await f.service.reconcile(f.context, f.orderId);
    f.source({
      ...f.current(),
      revision: 'e'.repeat(64),
      lines: f.current().lines.map((line) => ({ ...line, scopeVersion: '4' })),
    });
    await expect(
      f.service.reconcile(f.context, f.orderId),
    ).rejects.toMatchObject({ code: 'stale' });
    expect(f.balance('incoming')).toBe('100');
  });
});
