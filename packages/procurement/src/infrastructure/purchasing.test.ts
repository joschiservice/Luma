import { randomUUID } from 'node:crypto';

import { builtInMembership, makeTenantContext } from '@luma/identity';
import { describe, expect, it } from 'vitest';

import { createPurchasingService } from '../application/purchasing.js';
import type {
  PurchasingPlan,
  PurchasingRecommendation,
} from '../domain/purchasing.js';
import {
  purchasingPlanInputSchema,
  purchasingSettingsSchema,
} from './purchasing-validation.js';

function fixture() {
  const tenantId = randomUUID(),
    userId = randomUUID(),
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
  const now = new Date();
  const records = new Map<string, PurchasingPlan>();
  const executed: { id: string; readOnly: boolean }[] = [];
  let enabled = true,
    uncertain = false;
  const items: PurchasingRecommendation[] = Array.from(
    { length: 3 },
    (_, i) => ({
      key: String(i),
      supplierId: randomUUID(),
      supplierName: `Supplier ${i}`,
      skuId: randomUUID(),
      sku: `SKU-${i}`,
      termsRevision: 1,
      termsObservedAt: now.toISOString(),
      packSize: 10,
      minimumQuantity: 10,
      leadTimeDays: 7,
      supplierArticleNumber: null,
      unitPrice: { amount: '0.10000001', currency: 'EUR' },
      orderMinimumValue: { amount: '2.00000021', currency: 'EUR' },
      stocks: [],
      incoming: [],
      incomingQuantity: 0,
      demand: {
        daily: 1,
        units: 30,
        periodDays: 30,
        observedAt: now.toISOString(),
        evidenceRefs: [randomUUID()],
        complete: true,
      },
      existingOrders: [],
      rule: null,
      available: 0,
      daysOfCover: 0,
      rawQuantity: 20,
      quantity: 20,
      orderBy: now.toISOString(),
      missing: [],
    }),
  );
  for (const item of items)
    item.stocks.push({
      positionId: randomUUID(),
      skuId: item.skuId,
      sku: item.sku,
      locationId,
      location: 'Main',
      connectionId: randomUUID(),
      unit: 'each',
      available: 0,
      reserved: 0,
      observedAt: now.toISOString(),
      observationId: randomUUID(),
      complete: true,
      authoritative: true,
    });
  const service = createPurchasingService({
    parsePlan: (input) => purchasingPlanInputSchema.parse(input),
    parseSettings: (input) => purchasingSettingsSchema.parse(input),
    store: {
      settings: async () => ({
        demandPeriodDays: 30,
        safetyDays: 7,
        locationIds: [],
        revision: 0,
      }),
      saveSettings: async (_ctx, input) => input,
      plans: async () => [...records.values()],
      plan: async (_ctx, id) => records.get(id) ?? null,
      insert: async (_ctx, plan) => {
        records.set(plan.id, plan);

        return plan;
      },
      update: async (_ctx, plan) => {
        records.set(plan.id, plan);
      },
    },
    overview: async (_ctx, settings) => ({
      settings,
      items,
      locations: [{ id: locationId, name: 'Main' }],
      asOf: now.toISOString(),
      truncated: false,
    }),
    refreshContext: async (ctx) => ctx,
    principal: async () => context,
    released: async () => enabled,
    now: () => now,
    uuid: () => randomUUID(),
    admission: {
      prepare: async () => ({
        decisionId: randomUUID(),
        allowed: true,
        reason: null,
      }),
      decision: async () => ({ approved: true, rejected: false }),
      respond: async () => {},
      execute: async (_ctx, plan, readOnly) => {
        executed.push({ id: plan.id, readOnly });

        return { state: uncertain ? 'uncertain' : 'verified', failure: null };
      },
    },
  });
  const request = (
    index: number,
    reason = 'Buyer reviewed supplier minimum',
  ) => ({
    id: randomUUID(),
    supplierId: items[index]!.supplierId,
    reference: `PO-${index}`,
    reason,
    lines: [
      {
        skuId: items[index]!.skuId,
        locationId,
        quantity: 20,
        termsRevision: 1,
      },
    ],
  });

  return {
    service,
    context,
    items,
    executed,
    request,
    enable: (value: boolean) => {
      enabled = value;
    },
    uncertain: (value: boolean) => {
      uncertain = value;
    },
  };
}

describe('governed purchasing plans', () => {
  it('keeps supplier commands independent and returns exact proposal and execution retries', async () => {
    const f = fixture();
    const plans = await Promise.all(
      [0, 1, 2].map((i) => f.service.propose(f.context, f.request(i))),
    );
    expect(new Set(plans.map((p) => p.order.id)).size).toBe(3);
    for (const plan of plans) {
      expect(await f.service.propose(f.context, plan.request)).toEqual(plan);
      expect((await f.service.execute(f.context, plan.id)).state).toBe(
        'verified',
      );
      await f.service.execute(f.context, plan.id);
    }
    expect(f.executed).toHaveLength(3);
  });
  it('compares supplier minima exactly and requires the reviewed exception reason', async () => {
    const f = fixture();
    await expect(
      f.service.propose(f.context, f.request(0, '')),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(
      (await f.service.propose(f.context, f.request(0))).request.reason,
    ).toBe('Buyer reviewed supplier minimum');
  });
  it('reconciles uncertain drafts read-only even after release is disabled', async () => {
    const f = fixture();
    const plan = await f.service.propose(f.context, f.request(0));
    f.uncertain(true);
    expect((await f.service.execute(f.context, plan.id)).state).toBe(
      'uncertain',
    );
    f.enable(false);
    f.uncertain(false);
    expect((await f.service.reconcile(f.context, plan.id)).state).toBe(
      'verified',
    );
    expect(f.executed.map((call) => call.readOnly)).toEqual([false, true]);
  });
  it('rejects a changed payload reusing a saved plan identity', async () => {
    const f = fixture();
    const plan = await f.service.propose(f.context, f.request(0));
    await expect(
      f.service.propose(f.context, {
        ...plan.request,
        reason: 'Different intent',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
