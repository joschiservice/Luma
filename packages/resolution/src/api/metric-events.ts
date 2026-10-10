import '@luma/identity/http';

import {
  anyMember,
  metricEventsContract,
  type WorkspaceTopic,
  workspaceTopics,
} from '@luma/api-contract';
import type {
  IdentityService,
  Permission,
  TenantContext,
} from '@luma/identity';
import { hasPermission, IdentityError } from '@luma/identity';
import type { FastifyInstance } from 'fastify';

import type { MetricEvents } from '../application/metric-events.js';

/** The read permission an area needs. Needs you filters its own sources, so every member hears it. */
const topicPermissions: Record<WorkspaceTopic, Permission | null> = {
  orders: 'orders.read',
  connections: null,
  issues: 'issues.read',
  inventory: 'inventory.read',
  workflows: 'workflows.read',
  procurement: 'procurement.read',
  resolution: 'insights.read',
  decisions: null,
};

/** Lists the areas a member may hear about. */
function readableTopics(context: TenantContext) {
  return workspaceTopics.filter((topic) => {
    const permission = topicPermissions[topic];

    return !permission || hasPermission(context, permission);
  });
}

/**
 * Tells workspace members which areas changed, limited to areas they can read. Bursts coalesce
 * per stream. Access is rechecked on the five-second heartbeat and whenever the last check is
 * older than that, so revoked members stop receiving events within about five seconds.
 */
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
  app.get(
    metricEventsContract.events.path,
    { config: { access: anyMember } },
    async (request, reply) => {
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
      // The first event and every listener reconnection reconcile all readable areas.
      let everything = true;
      const changed = new Set<string>();
      let recheck = true;
      let checkedAt = 0;
      let readable: WorkspaceTopic[] = [];
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
      const pending = () => everything || changed.size > 0;
      const send = async () => {
        timer = undefined;
        if (closed || busy) return;
        busy = true;
        const heartbeat = recheck;
        const reconcile = everything || Date.now() - reconciledAt >= 30000;
        const areas = [...changed];
        everything = false;
        changed.clear();
        try {
          if (heartbeat || Date.now() - checkedAt >= 5000) {
            recheck = false;
            const fresh = await authorize(async () => {
              if (closed) return null;

              return identity.resolveTenant(
                request.headers.cookie
                  ? { cookie: request.headers.cookie }
                  : {},
                organizationId,
                request.id,
                { supportView: { read: null } },
              );
            });
            if (closed) return;
            if (
              !fresh ||
              fresh.actor.id !== context.actor.id ||
              fresh.supportView?.id !== context.supportView?.id ||
              fresh.tenantId !== organizationId
            )
              throw new Error('Access changed');
            readable = readableTopics(fresh);
            checkedAt = Date.now();
          }
          const topics = reconcile
            ? readable
            : readable.filter((topic) => areas.includes(topic));
          // Changes only in areas this member cannot read wait silently for the next heartbeat.
          if (!heartbeat && !reconcile && !topics.length) return;
          if (!reply.raw.headersSent) {
            reply.raw.writeHead(200, {
              'content-type': 'text/event-stream',
              'cache-control': 'no-store',
              'x-accel-buffering': 'no',
            });
          }
          if (reconcile) reconciledAt = Date.now();
          const event = {
            schemaVersion: 1,
            organizationId,
            scope: 'order-metrics',
            connected: events.connected,
            refetch: topics.length > 0,
            topics,
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
          if ((pending() || recheck) && !closed && !timer)
            timer = setTimeout(() => void send(), 75);
        }
      };
      unsubscribe = events.subscribe(organizationId, (wakeup) => {
        if (wakeup.topics)
          for (const topic of wakeup.topics) changed.add(topic);
        else everything = true;
        if (pending() && !busy && !closed && !timer)
          timer = setTimeout(() => void send(), 75);
      });
      const heartbeat = setInterval(() => {
        recheck = true;
        if (!busy && !timer) void send();
      }, 5000);
      heartbeat.unref();
      const lifetime = setTimeout(close, 5 * 60000);
      lifetime.unref();
      await send();
    },
  );
}
