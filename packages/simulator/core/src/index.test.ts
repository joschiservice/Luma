import { describe, expect, it } from 'vitest';

import {
  chaosPreset,
  charge,
  createMemoryStore,
  createRandom,
  createTransport,
  decide,
  decideWebhook,
  encodeCursor,
  type FaultRule,
  json,
  matchFault,
  poisson,
  type RateLimit,
  unit,
} from './index.js';

const request = (occurrence: number, overrides = {}) => ({
  seed: 44,
  instance: 'shopify-de',
  operation: 'orders.read',
  write: false,
  identity: `GET /orders?page=${occurrence % 50}`,
  occurrence: Math.floor(occurrence / 50),
  now: 0,
  ...overrides,
});

describe('deterministic randomness', () => {
  it('derives decisions from identity, not call order', () => {
    expect(unit(1, 'a', 2)).toBe(unit(1, 'a', 2));
    expect(unit(1, 'a', 2)).not.toBe(unit(1, 'a', 3));
    const first = createRandom(7);
    const second = createRandom(7);
    expect([first.next(), first.next()]).toEqual([
      second.next(),
      second.next(),
    ]);
  });

  it('draws Poisson counts around their mean', () => {
    const random = createRandom('poisson');
    const draws = Array.from({ length: 4_000 }, () => poisson(random, 3));
    const mean = draws.reduce((sum, value) => sum + value, 0) / draws.length;
    expect(mean).toBeGreaterThan(2.85);
    expect(mean).toBeLessThan(3.15);
    expect(poisson(random, 0)).toBe(0);
  });
});

describe('chaos decisions', () => {
  it('fails close to the configured share of requests and repeats them exactly', () => {
    const profile = chaosPreset('realistic');
    profile.transport.errorRate = 0.1;
    const decisions = Array.from({ length: 5_000 }, (_, index) =>
      decide(profile, request(index)),
    );
    const failed = decisions.filter((decision) => decision.fault).length;
    expect(failed / decisions.length).toBeGreaterThan(0.08);
    expect(failed / decisions.length).toBeLessThan(0.12);
    expect(decisions.map((d) => d.fault)).toEqual(
      Array.from(
        { length: 5_000 },
        (_, index) => decide(profile, request(index)).fault,
      ),
    );
    expect(
      new Set(decisions.flatMap((d) => (d.fault ? [d.fault] : []))).size,
    ).toBeGreaterThan(4);
  });

  it('never fails a calm request and applies overrides and windows to their targets', () => {
    const calm = chaosPreset('calm');
    expect(
      Array.from({ length: 1_000 }, (_, index) =>
        decide(calm, request(index)),
      ).some((decision) => decision.fault || decision.lose),
    ).toBe(false);
    const profile = chaosPreset('calm');
    profile.overrides = [
      {
        instance: 'jtl',
        errorRate: 1,
        mix: {
          'rate-limit': 1,
          unavailable: 0,
          'server-error': 0,
          timeout: 0,
          reset: 0,
          malformed: 0,
          'schema-drift': 0,
        },
      },
    ];
    expect(decide(profile, request(1, { instance: 'jtl' })).fault).toBe(
      'rate-limit',
    );
    expect(decide(profile, request(1)).fault).toBeNull();
    profile.windows = [
      {
        id: 'drill',
        label: 'Drill',
        startsAt: 0,
        durationMs: 60_000,
        everyMs: 3_600_000,
        errorRate: 1,
        fault: 'unavailable',
      },
    ];
    expect(
      decide(profile, request(1, { now: 3_600_000 + 1_000 })),
    ).toMatchObject({
      fault: 'unavailable',
      window: 'drill',
    });
    expect(
      decide(profile, request(1, { now: 3_600_000 + 120_000 })).fault,
    ).toBeNull();
  });

  it('decides write outcomes after commit and lost responses only for writes', () => {
    const profile = chaosPreset('calm');
    profile.transport.responseLossRate = 1;
    expect(decide(profile, request(1)).lose).toBe(false);
    expect(decide(profile, request(1, { write: true })).lose).toBe(true);
    profile.transport.responseLossRate = 0;
    profile.transport.errorRate = 1;
    profile.transport.mix = {
      unavailable: 0,
      'rate-limit': 0,
      'server-error': 0,
      timeout: 1,
      reset: 0,
      malformed: 0,
      'schema-drift': 0,
    };
    const phases = new Set(
      Array.from(
        { length: 200 },
        (_, index) =>
          decide(profile, request(index, { write: true })).afterCommit,
      ),
    );
    expect(phases).toEqual(new Set([true, false]));
  });

  it('drops and duplicates webhooks deterministically', () => {
    const profile = chaosPreset('bad-day');
    const decisions = Array.from({ length: 2_000 }, (_, index) =>
      decideWebhook(profile, 44, `event-${index}`),
    );
    const dropped =
      decisions.filter((decision) => decision.drop).length / decisions.length;
    expect(dropped).toBeGreaterThan(0.015);
    expect(dropped).toBeLessThan(0.05);
    expect(decideWebhook(profile, 44, 'event-1')).toEqual(decisions[1]);
  });
});

describe('manual faults', () => {
  it('matches instance, operation, resource, phase, occurrence, counts and expiry', () => {
    const rule: FaultRule = {
      id: 'one',
      instance: 'jtl',
      operation: 'orders.shipping-method.write',
      resource: '1',
      kind: 'response-loss',
      occurrence: 2,
      remaining: 1,
      matches: 0,
      status: 'armed',
    };
    const target = {
      instance: 'jtl',
      operation: 'orders.shipping-method.write',
      resource: '1',
      phase: 'after-commit' as const,
    };
    expect(
      matchFault([rule], { ...target, phase: 'before' }, 0),
    ).toBeUndefined();
    expect(matchFault([rule], target, 0)).toBeUndefined();
    expect(matchFault([rule], target, 0)).toBe(rule);
    expect(rule.status).toBe('triggered');
    const expiring: FaultRule = {
      ...rule,
      id: 'two',
      kind: 'unavailable',
      occurrence: 1,
      matches: 0,
      status: 'armed',
      expiresAt: 10,
    };
    expect(
      matchFault([expiring], { ...target, phase: 'before' }, 10),
    ).toBeUndefined();
    expect(expiring.status).toBe('expired');
  });
});

describe('memory record store', () => {
  it('pages by insertion and modification order with stable cursors and filters', async () => {
    const store = createMemoryStore();
    for (let index = 1; index <= 5; index++)
      await store.put(
        'Order',
        String(index),
        { index },
        { updatedAt: 100 - index, key: index % 2 ? 'odd' : 'even' },
      );
    const created = await store.page({ kind: 'Order', limit: 2 });
    expect(created.items.map((item) => item.id)).toEqual(['1', '2']);
    const next = await store.page({
      kind: 'Order',
      limit: 2,
      after: created.next,
    });
    expect(next.items.map((item) => item.id)).toEqual(['3', '4']);
    const updated = await store.page({
      kind: 'Order',
      limit: 10,
      order: 'updated',
    });
    expect(updated.items.map((item) => item.id)).toEqual([
      '5',
      '4',
      '3',
      '2',
      '1',
    ]);
    expect(
      (
        await store.page({
          kind: 'Order',
          limit: 10,
          key: 'odd',
          reverse: true,
        })
      ).items.map((item) => item.id),
    ).toEqual(['5', '3', '1']);
    expect(
      (
        await store.page({ kind: 'Order', limit: 10, updatedBefore: 97 })
      ).items.map((item) => item.id),
    ).toEqual(['4', '5']);
    expect(
      (await store.page({ kind: 'Order', limit: 2, offset: 3 })).items.map(
        (item) => item.id,
      ),
    ).toEqual(['4', '5']);
    for (const query of [
      { kind: 'Order', order: 'updated' as const },
      { kind: 'Order', order: 'updated' as const, reverse: true },
      { kind: 'Order', key: 'even' },
      { kind: 'Order', key: 'missing' },
    ]) {
      const single = await store.page({ ...query, limit: 1 });
      const sorted = await store.page({ ...query, limit: 10 });
      expect(single.items).toEqual(sorted.items.slice(0, 1));
      expect(single.next).toBe(
        sorted.items.length > 1
          ? encodeCursor(sorted.items[0]!, query.order ?? 'created')
          : null,
      );
    }
    expect(
      (await store.page({ kind: 'Order', order: 'updated', limit: 1 })).next,
    ).toBe('u95.5');
    expect(await store.count({ kind: 'Order', key: 'even' })).toBe(2);
    await store.put('Order', '1', { index: 9 }, { updatedAt: 200 });
    expect(await store.get('Order', '1')).toMatchObject({
      seq: 1,
      key: 'odd',
      data: { index: 9 },
    });
    expect(await store.sequence('order', 1001)).toBe(1001);
    expect(await store.sequence('order', 1001)).toBe(1002);
    const copy = createMemoryStore(store.snapshot());
    expect(await copy.get('Order', '3')).toEqual(await store.get('Order', '3'));
    expect(await copy.sequence('order')).toBe(1003);
  });
});

describe('transport and rate limits', () => {
  it('honors cancellation, lost responses and raw malformed bodies', async () => {
    const lost = createTransport(async () => ({ ...json({}), lost: true }));
    await expect(lost('https://provider.test/')).rejects.toThrow(
      'lost after commit',
    );
    const malformed = createTransport(async () => ({
      ...json(null),
      bodyText: '{"data":',
    }));
    await expect(
      (await malformed('https://provider.test/')).json(),
    ).rejects.toThrow();
    const controller = new AbortController();
    controller.abort();
    await expect(
      createTransport(async () => json({}))('https://provider.test/', {
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });

  it('refills a leaky bucket in real time', () => {
    const limit: RateLimit = {
      capacity: 10,
      restorePerSecond: 5,
      cost: () => 4,
      reject: () => json({}, 429),
    };
    const bucket = { available: 10, at: 0 };
    expect(charge(limit, bucket, 4, 0)).toBe(true);
    expect(charge(limit, bucket, 4, 0)).toBe(true);
    expect(charge(limit, bucket, 4, 0)).toBe(false);
    expect(charge(limit, bucket, 4, 1_000)).toBe(true);
  });
});
