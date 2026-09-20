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
