import { randomUUID } from 'node:crypto';

import { builtInMembership, makeTenantContext } from '@luma/identity';
import { afterEach, expect, it, vi } from 'vitest';

import {
  effectiveSupplierTerms,
  type SupplierTermsVersion,
} from '../domain/supplier-terms.js';
import { createPurchasingOverview } from './purchasing-overview.js';

afterEach(() => vi.useRealTimers());

it('keeps stale provider fields unavailable after a partial human override', async () => {
  vi.useFakeTimers();
  const now = new Date('2026-10-13T09:00:00.000Z');
  vi.setSystemTime(now);
  const tenantId = randomUUID(),
    userId = randomUUID(),
    supplierId = randomUUID(),
    skuId = randomUUID(),
    locationId = randomUUID();
  const context = makeTenantContext(
    { userId, sessionId: randomUUID() },
    {
      id: tenantId,
      name: 'Shop',
      slug: 'shop',
      dataRegion: 'AU',
      status: 'active',
    },
    builtInMembership(
      { id: randomUUID(), organizationId: tenantId, userId },
      'owner',
    ),
    randomUUID(),
  );
  const provider: SupplierTermsVersion = {
    id: randomUUID(),
    supplierId,
    skuId,
    revision: 1,
    source: 'provider',
    values: { packSize: 6, lineMinimumQuantity: 12, leadTimeDays: 7 },
    recordedAt: '2026-10-10T09:00:00.000Z',
    observedAt: '2026-10-10T09:00:00.000Z',
    actorId: 'sync',
    reason: 'Supplier read',
    connectionId: randomUUID(),
    sourceRecordId: 'supplier-item',
    sourceUpdatedAt: null,
    complete: true,
  };
  const manual: SupplierTermsVersion = {
    ...provider,
    id: randomUUID(),
    revision: 2,
    source: 'manual',
    values: { packSize: 6 },
    recordedAt: now.toISOString(),
    observedAt: now.toISOString(),
    actorId: userId,
    reason: 'Buyer verified pack',
    connectionId: null,
  };
  const history = [provider, manual];
  const stock = {
    positionId: randomUUID(),
    skuId,
    sku: 'SKU',
    locationId,
    location: 'Main',
    connectionId: provider.connectionId!,
    unit: 'each',
    available: 0,
    reserved: 0,
    observedAt: now.toISOString(),
    observationId: randomUUID(),
    complete: true,
    authoritative: true,
  };
  const overview = createPurchasingOverview({
    terms: {
      list: async () => ({
        items: [
          {
            supplierId,
            skuId,
            supplierName: 'Supplier',
            sku: 'SKU',
            revision: 2,
            history,
            ...effectiveSupplierTerms(history, '2026-10-13'),
            lastReadAt: provider.observedAt,
            lastReadComplete: true,
          },
        ],
        canManage: true,
        enabled: true,
      }),
    },
    procurement: { orders: async () => ({ items: [], canManage: true }) },
    inputs: async () => ({
      stocks: [stock],
      demand: new Map([
        [
          skuId,
          {
            daily: 2,
            units: 60,
            periodDays: 30,
            observedAt: now.toISOString(),
            evidenceRefs: [randomUUID()],
            complete: true,
          },
        ],
      ]),
      rules: [],
      truncated: false,
    }),
    incoming: async () => ({
      items: [],
      truncated: false,
      supplierOrdersUnavailable: false,
      unavailableNativeIncoming: false,
      asOf: now.toISOString(),
    }),
  });
  const settings = {
    demandPeriodDays: 30,
    safetyDays: 7,
    locationIds: [],
    revision: 0,
  };
  const partial = await overview(context, settings);
  expect(partial.items[0]!.missing).toContain('terms_stale');
  expect(partial.items[0]!.quantity).toBeNull();
  expect(partial.items[0]!.termsObservedAt).toBe(provider.observedAt);
  manual.values = { packSize: 6, lineMinimumQuantity: 12, leadTimeDays: 7 };
  const reviewed = await overview(context, settings);
  expect(reviewed.items[0]!.missing).toEqual([]);
  expect(reviewed.items[0]!.quantity).toBeGreaterThan(0);
});
