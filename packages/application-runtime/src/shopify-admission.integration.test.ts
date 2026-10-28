import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

import {
  type BudgetFeedback,
  createSharedReadBudget,
} from '@luma/connector-shopify';
import type { AtomicStore } from '@luma/platform';
import { createValkeyStore } from '@luma/platform/composition';
import { GenericContainer } from 'testcontainers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

const url = process.env.SHOPIFY_ADMISSION_URL;
// Child processes start Node and connect to Valkey before they report a state, which can take
// longer than the default poll limit when suites run in parallel. Bounds under test are set
// through each budget's own wait limit, not through these waits.
const childWait = { timeout: 15_000 };

describe.skipIf(!url)('Shopify admission on real Valkey', () => {
  let store: AtomicStore;
  let key: string;
  const children: ReturnType<typeof fork>[] = [];
  beforeEach(async () => {
    store = createValkeyStore(url!);
    key = `luma:admission-test:{${randomUUID()}}`;
    await seed(store, key);
  });
  afterEach(async () => {
    for (const child of children.splice(0))
      if (child.exitCode === null) child.kill();
    await store.close();
  });

  function child(
    purpose: 'foreground' | 'history',
    hold = false,
    leaseMs = 5000,
  ) {
    const process_ = fork(
      fileURLToPath(
        new URL('./test-support/shopify-admission-child.mjs', import.meta.url),
      ),
      [],
      {
        execArgv: [],
        env: { PATH: process.env.PATH, SHOPIFY_ADMISSION_URL: url },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    );
    children.push(process_);
    const states: {
      state: string;
      code?: string | undefined;
      providerCode?: string | undefined;
    }[] = [];
    process_.on('message', (message) => {
      const state = z
        .object({
          state: z.string(),
          code: z.string().optional(),
          providerCode: z.string().optional(),
        })
        .parse(message);
      states.push(state);
      if (state.state === 'ready')
        process_.send({ key, purpose, hold, leaseMs });
    });

    return { process: process_, states };
  }

  it('admits foreground work across processes while history is holding capacity', async () => {
    const importer = child('history', true);
    await expect
      .poll(
        () => importer.states.some((s) => s.state === 'admitted'),
        childWait,
      )
      .toBe(true);
    await expect(
      createSharedReadBudget({
        store,
        key,
        purpose: 'history',
        maxWaitMs: 0,
      }).run('pending-refund', async () => true),
    ).rejects.toMatchObject({ failure: { retryAfterMs: 50 } });
    const nextImport = child('history');
    const foreground = child('foreground');
    await expect
      .poll(
        () =>
          nextImport.states.some(
            (s) => s.providerCode === 'ADMISSION_DEFERRED',
          ),
        childWait,
      )
      .toBe(true);
    await expect
      .poll(
        () => foreground.states.some((s) => s.state === 'completed'),
        childWait,
      )
      .toBe(true);
    importer.process.send('release');
    await expect
      .poll(
        () => importer.states.some((s) => s.state === 'completed'),
        childWait,
      )
      .toBe(true);
  }, 30_000);

  it('learns a background shape without requiring a completely full bucket and leaves foreground waiting bounded', async () => {
    await createSharedReadBudget({ store, key }).run(
      'spent',
      async (feedback) => feedback.observe('spent', 50, 1950, 100, 50, 2000),
    );
    const importer = child('history', true);
    await expect
      .poll(
        () => importer.states.some((s) => s.state === 'admitted'),
        childWait,
      )
      .toBe(true);
    const foreground = createSharedReadBudget({ store, key, maxWaitMs: 1500 });
    await expect(
      foreground.run('investigate', async (feedback) => {
        await feedback.beforeSend?.();
        await feedback.observe('investigate', 1, 1949, 100, 1, 2000);

        return 'fresh';
      }),
    ).resolves.toBe('fresh');
    importer.process.send('release');
    await expect
      .poll(
        () => importer.states.some((s) => s.state === 'completed'),
        childWait,
      )
      .toBe(true);
  }, 30_000);

  it('admits an action at its calculated cost before Shopify has reported a cost for it', async () => {
    await spend(store, key, 525);
    const action = (cost?: number) =>
      createSharedReadBudget({ store, key }).run(
        'release-hold',
        async () => 'sent',
        { mutation: true, ...(cost === undefined ? {} : { cost }) },
      );
    // Without a cost, the single-query maximum needs more restore than the two-second limit.
    await expect(action()).rejects.toMatchObject({
      failure: { providerCode: 'ADMISSION_DEFERRED' },
    });
    await expect(action(10)).resolves.toBe('sent');
  });

  it('keeps one single-query maximum for foreground work when background shapes have a calculated cost', async () => {
    await spend(store, key, 1500);
    const page = (cost?: number) =>
      createSharedReadBudget({
        store,
        key,
        purpose: 'history',
        maxWaitMs: 0,
      }).run('page', async () => 'page', cost === undefined ? {} : { cost });
    await expect(page(400)).resolves.toBe('page');
    await expect(page(600)).rejects.toMatchObject({
      failure: { providerCode: 'ADMISSION_DEFERRED' },
    });
    // An uncosted probe assumes the maximum and borrows one second of restore from the reserve.
    await expect(page()).rejects.toMatchObject({
      failure: { providerCode: 'ADMISSION_DEFERRED' },
    });
  });

  it('recovers a dead process concurrency slot without refunding its unknown effect', async () => {
    const importer = child('history', true, 250);
    await expect
      .poll(
        () => importer.states.some((s) => s.state === 'admitted'),
        childWait,
      )
      .toBe(true);
    importer.process.kill();
    const foreground = createSharedReadBudget({
      store,
      key,
      concurrency: 1,
      maxWaitMs: 1000,
    });
    await expect(
      foreground.run('work', async (feedback) => {
        feedback.dispatched?.();

        return 'read';
      }),
    ).resolves.toBe('read');
    // Only provider restore replenishes the consumed reservation: another unknown-cost read must defer.
    const next = createSharedReadBudget({ store, key, maxWaitMs: 0 });
    await expect(next.run('other', async () => 'read')).rejects.toMatchObject({
      failure: { providerCode: 'ADMISSION_DEFERRED' },
    });
  }, 30_000);

  it('shares cooldown while other shops and tenants keep progressing', async () => {
    const budget = createSharedReadBudget({ store, key, maxWaitMs: 0 });
    await budget.cooldown(5000);
    await expect(
      createSharedReadBudget({ store, key, maxWaitMs: 0 }).run(
        'work',
        async () => true,
      ),
    ).rejects.toMatchObject({ failure: { retryAfterMs: expect.any(Number) } });
    const independent = `${key}:other-shop`;
    await seed(store, independent);
    await expect(
      createSharedReadBudget({ store, key: independent }).run(
        'work',
        async () => true,
      ),
    ).resolves.toBe(true);
  });

  it('does not inflate capacity when concurrent responses complete out of order', async () => {
    let firstFeedback: BudgetFeedback | undefined;
    let release!: () => void;
    const first = createSharedReadBudget({ store, key }).run(
      'first',
      async (feedback) => {
        firstFeedback = feedback;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        await feedback.observe('first', 1000, 1500, 100, 500, 2000);
      },
    );
    await expect.poll(() => !!firstFeedback).toBe(true);
    await createSharedReadBudget({ store, key }).run(
      'second',
      async (feedback) => {
        await feedback.observe('second', 1000, 0, 100, 1000, 2000);
      },
    );
    release();
    await first;
    const remaining = await store.run(
      "return tonumber(redis.call('HGET', KEYS[1], 'available'))",
      key,
      [],
    );
    expect(Number(remaining)).toBeLessThan(100);
    await expect(
      createSharedReadBudget({ store, key, maxWaitMs: 0 }).run(
        'third',
        async () => true,
      ),
    ).rejects.toMatchObject({
      failure: { providerCode: 'ADMISSION_DEFERRED' },
    });
  });

  it('refunds each reservation once when healthy concurrent responses finish out of order', async () => {
    let release!: () => void;
    let pending = false;
    const first = createSharedReadBudget({ store, key }).run(
      'first',
      async (feedback) => {
        pending = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        await feedback.observe('first', 1000, 1500, 100, 500, 2000);
      },
    );
    await expect.poll(() => pending).toBe(true);
    await createSharedReadBudget({ store, key }).run(
      'second',
      async (feedback) =>
        feedback.observe('second', 1000, 500, 100, 1000, 2000),
    );
    release();
    await first;
    const available = await store.run(
      "return tonumber(redis.call('HGET', KEYS[1], 'available'))",
      key,
      [],
    );
    expect(Number(available)).toBeGreaterThanOrEqual(500);
  });

  it('corrects conservative drift from a fresh isolated provider observation', async () => {
    for (let index = 0; index < 3; index++)
      await createSharedReadBudget({ store, key }).run(
        'isolated',
        async (feedback) => {
          await feedback.beforeSend?.();
          await feedback.observe('isolated', 1000, 1999, 100, 1, 2000);
        },
      );
    const available = await store.run(
      "return tonumber(redis.call('HGET', KEYS[1], 'available'))",
      key,
      [],
    );
    expect(Number(available)).toBe(1999);
  });

  it('relearns conservatively after coordinator restart and invalidates old permits', async () => {
    const container = await new GenericContainer('valkey/valkey:9.1.2-alpine')
      .withExposedPorts({ container: 6379, host: await availablePort() })
      .withCommand(['valkey-server', '--appendonly', 'yes'])
      .start();
    const isolated = createValkeyStore(
      `redis://${container.getHost()}:${container.getMappedPort(6379)}`,
    );
    try {
      await seed(isolated, key);
      let continue_!: () => void;
      let held = false;
      const request = createSharedReadBudget({ store: isolated, key }).run(
        'before-restart',
        async (feedback) => {
          held = true;
          await new Promise<void>((resolve) => {
            continue_ = resolve;
          });
          await feedback.beforeSend?.();

          return 'sent';
        },
      );
      const outcome = request.catch((error: unknown) => error);
      await expect.poll(() => held).toBe(true);
      await container.restart();
      await expect.poll(() => isolated.ready(), { timeout: 15000 }).toBe(true);
      continue_();
      await expect(outcome).resolves.toMatchObject({
        failure: { code: 'unavailable' },
      });
      await expect(
        createSharedReadBudget({ store: isolated, key }).run(
          'after-restart',
          async (feedback) => {
            await feedback.observe('after-restart', 1, 1999, 100, 1, 2000);

            return 'fresh';
          },
        ),
      ).resolves.toBe('fresh');
    } finally {
      await isolated.close();
      await container.stop();
    }
  }, 30000);
});

async function seed(store: AtomicStore, key: string) {
  await createSharedReadBudget({ store, key }).run(
    'probe',
    async (feedback) => {
      await feedback.observe('probe', 0, 2000, 100, 0, 2000);
    },
  );
}

/** Leaves `available` points after an isolated request whose fresh snapshot Shopify reported. */
async function spend(store: AtomicStore, key: string, available: number) {
  await createSharedReadBudget({ store, key }).run(
    'spent',
    async (feedback) => {
      await feedback.beforeSend?.();
      await feedback.observe('spent', 1, available, 100, 1, 2000);
    },
  );
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Test port was not allocated');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );

  return address.port;
}
