import type { IdentityService } from '@luma/identity';
import { IdentityError } from '@luma/identity';
import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';

import { testContext } from '../application/tenant-context.fixture.js';
import { registerMetricEvents } from './metric-events.js';

it('disconnects a slow consumer and releases its subscription', async () => {
  const app = Fastify();
  const unsubscribe = vi.fn();
  const context = testContext({ userId: 'actor' });
  app.decorateRequest('tenantContext', null);
  app.addHook('onRequest', async (request, reply) => {
    request.tenantContext = context;
    // A false write result is Node's backpressure signal, independent of socket buffer size.
    vi.spyOn(reply.raw, 'write').mockReturnValue(false);
  });
  registerMetricEvents(app, { connected: true, subscribe: () => unsubscribe }, {
    resolveTenant: async () => context,
  } as unknown as IdentityService);
  const response = await app.inject(
    `/v1/organizations/${context.tenantId}/metrics/events`,
  );
  expect(response.statusCode).toBe(200);
  expect(unsubscribe).toHaveBeenCalledOnce();
  await app.close();
});

it('subscribes before the initial read and follows a concurrent change without rechecking fresh access', async () => {
  const app = Fastify();
  const context = testContext({ userId: 'actor' });
  let wake: (() => void) | undefined;
  const frames: string[] = [];
  let reads = 0;
  app.decorateRequest('tenantContext', null);
  app.addHook('onRequest', async (request, reply) => {
    request.tenantContext = context;
    vi.spyOn(reply.raw, 'write').mockImplementation((frame) => {
      frames.push(String(frame));

      return frames.length < 2;
    });
  });
  registerMetricEvents(
    app,
    {
      connected: true,
      subscribe: (_tenant, callback) => {
        wake = () => callback({ connected: true });

        return () => {
          wake = undefined;
        };
      },
    },
    {
      resolveTenant: async () => {
        reads++;
        if (reads === 1) {
          expect(wake).toBeDefined();
          wake?.();
        }

        return context;
      },
    } as unknown as IdentityService,
  );
  await app.inject(`/v1/organizations/${context.tenantId}/metrics/events`);
  expect(reads).toBe(1);
  expect(frames).toHaveLength(2);
  expect(frames.every((frame) => frame.includes('"refetch":true'))).toBe(true);
  expect(wake).toBeUndefined();
  await app.close();
});

it('bounds concurrent authorization reads across subscriptions', async () => {
  const app = Fastify();
  const tenantId = '00000000-0000-4000-8000-000000000001';
  let running = 0;
  let maximum = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  app.decorateRequest('tenantContext', null);
  app.addHook('onRequest', async (request, reply) => {
    request.tenantContext = testContext({
      tenantId,
      userId: request.headers.cookie ?? 'anonymous',
    });
    vi.spyOn(reply.raw, 'write').mockReturnValue(false);
  });
  registerMetricEvents(
    app,
    {
      connected: true,
      subscribe: () => () => {
        /* No transport resources in this fixture. */
      },
    },
    {
      resolveTenant: async (headers: { cookie: string }) => {
        running++;
        maximum = Math.max(maximum, running);
        await gate;
        running--;

        return testContext({ tenantId, userId: headers.cookie });
      },
    } as unknown as IdentityService,
  );
  const requests = Array.from({ length: 16 }, (_, index) =>
    app
      .inject({
        url: `/v1/organizations/${tenantId}/metrics/events`,
        headers: { cookie: `actor-${index}` },
      })
      .then((response) => response.statusCode),
  );
  await vi.waitFor(() => expect(running).toBe(8));
  release();
  expect(await Promise.all(requests)).toEqual(Array(16).fill(200));
  expect(maximum).toBe(8);
  await app.close();
});

function streamFrames(
  context: ReturnType<typeof testContext>,
  resolveTenant: () => Promise<ReturnType<typeof testContext>>,
) {
  const app = Fastify();
  const frames: string[] = [];
  let wake: ((topics?: string[]) => void) | undefined;
  const unsubscribe = vi.fn();
  app.decorateRequest('tenantContext', null);
  app.addHook('onRequest', async (request, reply) => {
    request.tenantContext = context;
    vi.spyOn(reply.raw, 'write').mockImplementation((frame) => {
      frames.push(String(frame));

      return true;
    });
  });
  registerMetricEvents(
    app,
    {
      connected: true,
      subscribe: (_tenant, callback) => {
        wake = (topics) =>
          callback(topics ? { connected: true, topics } : { connected: true });

        return unsubscribe;
      },
    },
    { resolveTenant } as unknown as IdentityService,
  );
  const response = app.inject(
    `/v1/organizations/${context.tenantId}/metrics/events`,
  );

  return {
    app,
    frames,
    unsubscribe,
    response,
    wake: (topics?: string[]) => wake?.(topics),
    events: () =>
      frames
        .filter((frame) => frame.includes('event: resync'))
        .map(
          (frame) =>
            JSON.parse(frame.slice(frame.indexOf('data: ') + 6)) as {
              refetch: boolean;
              topics: string[];
            },
        ),
  };
}

it('names changed areas and keeps areas outside the role silent', async () => {
  vi.useFakeTimers();
  try {
    const context = testContext({
      userId: 'actor',
      permissions: ['orders.read'],
    });
    const stream = streamFrames(context, async () => context);
    await vi.advanceTimersByTimeAsync(0);
    expect(stream.events()).toEqual([
      expect.objectContaining({
        refetch: true,
        topics: ['orders', 'connections', 'decisions'],
      }),
    ]);

    stream.wake(['procurement']);
    await vi.advanceTimersByTimeAsync(100);
    expect(stream.events()).toHaveLength(1);

    stream.wake(['procurement', 'decisions']);
    stream.wake(['orders']);
    await vi.advanceTimersByTimeAsync(100);
    expect(stream.events().at(-1)).toMatchObject({
      refetch: true,
      topics: ['orders', 'decisions'],
    });

    stream.wake();
    await vi.advanceTimersByTimeAsync(100);
    expect(stream.events().at(-1)?.topics).toEqual([
      'orders',
      'connections',
      'decisions',
    ]);

    await vi.advanceTimersByTimeAsync(5000);
    expect(stream.events().at(-1)).toMatchObject({
      refetch: false,
      topics: [],
    });
    await stream.app.close();
  } finally {
    vi.useRealTimers();
  }
});

it('rechecks access on the heartbeat and closes once membership is gone', async () => {
  vi.useFakeTimers();
  try {
    const context = testContext({ userId: 'actor' });
    let reads = 0;
    const stream = streamFrames(context, async () => {
      reads++;
      if (reads > 1) throw new IdentityError(404, 'NOT_FOUND', 'Not found');

      return context;
    });
    await vi.advanceTimersByTimeAsync(0);
    for (let index = 0; index < 20; index++) {
      stream.wake(['decisions']);
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(reads).toBe(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(reads).toBe(2);
    expect(stream.frames.at(-1)).toContain('event: access-check');
    expect(stream.unsubscribe).toHaveBeenCalledOnce();
    await stream.app.close();
  } finally {
    vi.useRealTimers();
  }
});
