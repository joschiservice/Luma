import { initContract } from '@ts-rest/core';
import { z } from 'zod';

import { apiErrorSchema, caseParams } from '../common.js';

const c = initContract();

export const caseEventsContract = c.router({
  events: {
    method: 'GET',
    path: '/v1/organizations/:organizationId/exceptions/:exceptionId/events',
    pathParams: caseParams,
    responses: {
      200: c.otherResponse({
        contentType: 'text/event-stream',
        body: z.string(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      429: apiErrorSchema,
      500: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: 'Follow case progress',
    description:
      'Authenticated SSE emits resync events with a current progress snapshot every five seconds. Refetch case, review and timeline on each event and reconnect. Last-Event-ID always resynchronizes current state; events are not an audit replay. Sessions and membership are checked before each snapshot. Streams reconnect after one minute. Slow consumers are disconnected. Use the timeline endpoint for persisted history.',
  },
});

/**
 * Areas of workspace data a change event can name. `decisions` covers every source of the Needs
 * you queue, so a source table belongs to its own area and to `decisions`.
 */
export const workspaceTopics = [
  'orders',
  'connections',
  'issues',
  'inventory',
  'workflows',
  'procurement',
  'resolution',
  'decisions',
] as const;

export const workspaceTopicSchema = z.enum(workspaceTopics);

export type WorkspaceTopic = z.infer<typeof workspaceTopicSchema>;

export const metricStreamEventSchema = z.object({
  schemaVersion: z.literal(1),
  organizationId: z.string().uuid(),
  scope: z.literal('order-metrics'),
  connected: z.boolean(),
  refetch: z.boolean(),
  /**
   * Areas to read again when `refetch` is true. Unknown names from a newer server are kept so an
   * open page does not drop its stream; clients ignore names they do not use.
   */
  topics: z.array(z.string().min(1).max(40)).max(20),
  sentAt: z.string().datetime(),
});

export const metricEventsContract = c.router({
  events: {
    method: 'GET',
    path: '/v1/organizations/:organizationId/metrics/events',
    pathParams: z.object({ organizationId: z.string().uuid() }),
    responses: {
      200: c.otherResponse({
        contentType: 'text/event-stream',
        body: z.string(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      429: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: 'Follow workspace changes',
    description:
      'Authenticated SSE tells workspace members which areas of data changed. Subscribe before the first query. On resync events with refetch: true, read again the views that depend on a listed topic; on reconnect, read all of them. Topics are limited to areas the member can read; decisions is available to every member. Events contain no records, totals or replay history. Last-Event-ID requests current state. Access is rechecked at least every five seconds and the stream closes when it is lost. Slow consumers disconnect and must resynchronize. Reconciliation lists every readable topic every 30 seconds.',
  },
});
