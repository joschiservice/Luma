import '@luma/identity/http';

import { metricEventsContract } from '@luma/api-contract';
import type { IdentityService } from '@luma/identity';
import { IdentityError } from '@luma/identity';
import type { FastifyInstance } from 'fastify';

import type { MetricEvents } from '../application/metric-events.js';

/** Delivers bounded, tenant-scoped invalidations after rechecking the original session. */
export function registerMetricEvents(
  app: FastifyInstance,
  events?: MetricEvents,
  identity?: IdentityService,
) {
  const streams = new Set<() => void>();
  const actors = new Map<string, number>();
  let draining = false;
  // Limit concurrent authorization reads across all streams in this API process.
  let running = 0;
  const waiting: (() => void)[] = [];
  const authorize = async <T>(read: () => Promise<T>) => {
    if (waiting.length >= 100)
      throw new IdentityError(
        503,
        'SERVICE_UNAVAILABLE',
        'Live metrics are busy',
      );
    if (running >= 8)
      await new Promise<void>((resolve) => waiting.push(resolve));
    else running++;
    try {
      return await read();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running--;
    }
  };
  app.addHook('preClose', async () => {
    draining = true;
    for (const close of [...streams]) close();
  });
  app.get(metricEventsContract.events.path, async (request, reply) => {
    if (!events || !identity || draining)
      throw new IdentityError(
        503,
        'SERVICE_UNAVAILABLE',
        'Live metrics are unavailable',
      );
    const parsed = metricEventsContract.events.pathParams.safeParse(
      request.params,
    );
    if (!parsed.success)
      return reply.code(400).send({
        code: 'VALIDATION_ERROR',
        message: 'Invalid request',
        requestId: request.id,
      });
    const { organizationId } = parsed.data;
    const context = request.tenantContext;
    if (!context)
      throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue');
    const key = `${organizationId}:${context.actor.id}`;
    if (streams.size >= 100 || (actors.get(key) ?? 0) >= 3) {
      return reply.code(429).send({
        code: 'TOO_MANY_REQUESTS',
        message: 'Too many active metric streams',
        requestId: request.id,
      });
    }
    let closed = false;
    let busy = false;
    let dirty = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe = () => {
      /* Subscription is installed before the first read. */
    };
    let reconciledAt = Date.now();
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      clearTimeout(lifetime);
      clearInterval(heartbeat);
      unsubscribe();
      streams.delete(close);
      const count = (actors.get(key) ?? 1) - 1;
      if (count) actors.set(key, count);
      else actors.delete(key);
      reply.raw.end();
      reply.raw.destroy();
    };
    streams.add(close);
    actors.set(key, (actors.get(key) ?? 0) + 1);
    reply.raw.on('close', close);
    reply.hijack();
    const send = async () => {
      timer = undefined;
      if (closed || busy) return;
      busy = true;
      const refetch = dirty || Date.now() - reconciledAt >= 30000;
      dirty = false;
      try {
        const fresh = await authorize(async () => {
          if (closed) return null;

          return identity.resolveTenant(
            request.headers.cookie ? { cookie: request.headers.cookie } : {},
            organizationId,
            request.id,
          );
        });
        if (closed) return;
        if (
          !fresh ||
          fresh.actor.id !== context.actor.id ||
          fresh.tenantId !== organizationId
        )
          throw new Error('Access changed');
        if (!reply.raw.headersSent) {
          reply.raw.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-store',
            'x-accel-buffering': 'no',
          });
        }
        if (refetch) reconciledAt = Date.now();
        const event = {
          schemaVersion: 1,
          organizationId,
          scope: 'order-metrics',
          connected: events.connected,
          refetch,
          sentAt: new Date().toISOString(),
        };
        if (
          !reply.raw.write(
            `retry: 1000\nevent: resync\ndata: ${JSON.stringify(event)}\n\n`,
          )
        )
          close();
      } catch (error) {
        if (!reply.raw.headersSent && !closed) {
          const status =
            error instanceof IdentityError ? error.statusCode : 503;
          reply.raw.writeHead(status, { 'content-type': 'application/json' });
          reply.raw.write(
            JSON.stringify({
              code:
                error instanceof IdentityError
                  ? error.code
                  : 'SERVICE_UNAVAILABLE',
              message: 'Live metrics are unavailable',
              requestId: request.id,
            }),
          );
        } else if (
          !closed &&
          reply.raw.headersSent &&
          error instanceof IdentityError &&
          [401, 403, 404].includes(error.statusCode)
        )
          reply.raw.write('event: access-check\ndata: {}\n\n');
        close();
      } finally {
        busy = false;
        if (dirty && !closed && !timer)
          timer = setTimeout(() => void send(), 75);
      }
    };
    unsubscribe = events.subscribe(organizationId, () => {
      dirty = true;
      if (!busy && !closed && !timer) timer = setTimeout(() => void send(), 75);
    });
    const heartbeat = setInterval(() => {
      if (!busy && !timer) void send();
    }, 5000);
    heartbeat.unref();
    const lifetime = setTimeout(close, 5 * 60000);
    lifetime.unref();
    await send();
  });
}
