import '@luma/identity/http';

import { randomUUID } from 'node:crypto';

import {
  apiContract,
  caseEventsContract,
  caseProgressSchema,
  caseReviewSchema,
  caseStreamEventSchema,
  caseTimelineSchema,
  decisionReceiptSchema,
} from '@luma/api-contract';
import type { IdentityService } from '@luma/identity';
import { IdentityError } from '@luma/identity';
import { initServer } from '@ts-rest/fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { DeskService } from '../application/desk.js';

function use(request: FastifyRequest, service?: DeskService) {
  if (!request.tenantContext)
    throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue');
  if (!service)
    throw new IdentityError(
      503,
      'SERVICE_UNAVAILABLE',
      'Case decisions are unavailable',
    );

  return { context: request.tenantContext, service };
}

/**
 * Creates authenticated review, decision, receipt, progress, and timeline handlers for the
 * operator desk.
 */
export function deskRoutes(service?: DeskService) {
  return initServer().router(apiContract.caseDesk, {
    review: async ({ request, params }) => {
      const s = use(request, service);

      return {
        status: 200,
        body: caseReviewSchema.parse(
          await s.service.review(s.context, params.exceptionId),
        ),
      };
    },
    refresh: async ({ request, params }) => {
      const s = use(request, service);
      await s.service.refresh(s.context, params.exceptionId);

      return {
        status: 200,
        body: caseReviewSchema.parse(
          await s.service.review(s.context, params.exceptionId),
        ),
      };
    },
    decide: async ({ request, params, body }) => {
      const s = use(request, service);

      return {
        status: 200,
        body: decisionReceiptSchema.parse(
          await s.service.decide(s.context, params.exceptionId, body),
        ),
      };
    },
    receipt: async ({ request, params }) => {
      const s = use(request, service);

      return {
        status: 200,
        body: decisionReceiptSchema.parse(
          await s.service.receipt(
            s.context,
            params.exceptionId,
            params.commandId,
          ),
        ),
      };
    },
    progress: async ({ request, params }) => {
      const s = use(request, service);

      return {
        status: 200,
        body: caseProgressSchema.parse(
          await s.service.progress(s.context, params.exceptionId),
        ),
      };
    },
    timeline: async ({ request, params, query }) => {
      const s = use(request, service);

      return {
        status: 200,
        body: caseTimelineSchema.parse(
          await s.service.timeline(s.context, params.exceptionId, query),
        ),
      };
    },
  });
}

/**
 * Registers bounded progress streams that recheck the session and tenant access before each
 * snapshot.
 */
export function registerDeskEvents(
  app: FastifyInstance,
  service?: DeskService,
  identity?: IdentityService,
  settings = { intervalMs: 5000, lifetimeMs: 60000 },
) {
  let draining = false;
  const streams = new Map<string, Set<() => void>>();
  const shutdown = () => {
    for (const entries of streams.values())
      for (const close of [...entries]) close();
  };
  app.addHook('preClose', async () => {
    draining = true;
    shutdown();
  });
  app.get(caseEventsContract.events.path, async (request, reply) => {
    const s = use(request, service);
    if (draining)
      throw new IdentityError(
        503,
        'SERVICE_UNAVAILABLE',
        'Service is shutting down',
      );
    if (!identity)
      throw new IdentityError(
        503,
        'SERVICE_UNAVAILABLE',
        'Identity is unavailable',
      );
    const parsed = caseEventsContract.events.pathParams.safeParse(
      request.params,
    );
    if (!parsed.success)
      return reply.code(400).send({
        code: 'VALIDATION_ERROR',
        message: 'Invalid request',
        requestId: request.id,
      });
    const { organizationId, exceptionId } = parsed.data;
    const key = `${organizationId}:${s.context.actor.id}`;
    const group = streams.get(key) ?? new Set<() => void>();
    if (
      group.size >= 3 ||
      [...streams.values()].reduce((n, g) => n + g.size, 0) >= 100
    )
      return reply.code(429).send({
        code: 'TOO_MANY_REQUESTS',
        message: 'Too many active case streams',
        requestId: request.id,
      });
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lifetime: ReturnType<typeof setTimeout> | undefined;
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      clearTimeout(lifetime);
      group.delete(close);
      if (!group.size) streams.delete(key);
      reply.raw.end();
    };
    // Reserve before awaiting reads, so simultaneous requests cannot exceed the cap.
    group.add(close);
    streams.set(key, group);
    try {
      const initial = caseProgressSchema.parse(
        await s.service.progress(s.context, exceptionId),
      );
      if (closed) return;
      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        'x-accel-buffering': 'no',
        'x-request-id': request.id,
      });
      reply.raw.on('close', close);
      const write = (progress: typeof initial) => {
        const event = caseStreamEventSchema.parse({
          schemaVersion: 1,
          exceptionId,
          refetch: true,
          progress,
        });
        if (
          !reply.raw.write(
            `id: ${randomUUID()}\nevent: resync\ndata: ${JSON.stringify(event)}\n\n`,
          )
        )
          close();
      };
      write(initial);
      if (closed) return;
      lifetime = setTimeout(close, settings.lifetimeMs);
      lifetime.unref();
      const poll = async () => {
        if (closed) return;
        try {
          // Refresh the original session, not just the membership captured at connection time.
          const context = await identity.resolveTenant(
            request.headers.cookie ? { cookie: request.headers.cookie } : {},
            organizationId,
            request.id,
          );
          if (
            context.actor.id !== s.context.actor.id ||
            context.tenantId !== organizationId
          )
            throw new Error('Scope changed');
          const progress = caseProgressSchema.parse(
            await s.service.progress(context, exceptionId),
          );
          if (closed) return;
          write(progress);
          if (!closed) {
            timer = setTimeout(() => void poll(), settings.intervalMs);
            timer.unref();
          }
        } catch {
          close();
        }
      };
      if (!closed) {
        timer = setTimeout(() => void poll(), settings.intervalMs);
        timer.unref();
      }
    } catch (error) {
      group.delete(close);
      if (!group.size) streams.delete(key);
      if (reply.sent) {
        close();

        return;
      }
      throw error;
    }
  });
}
