import { z } from 'zod';

import {
  askAssistantSchema,
  assistantAnswerSchema,
  assistantAvailabilitySchema,
} from '../assistant.js';
import {
  anyMember,
  endpoint,
  organizationParamsSchema,
  requires,
} from '../common.js';

const path = '/v1/organizations/{organizationId}/assistant';

export const assistantContract = {
  availability: endpoint
    .route({
      method: 'GET',
      path,
      summary: 'Check whether you can ask Luma here',
      description:
        'Any member can check this. Asking Luma needs the Use Ask Luma permission and an EU model route with zero data retention. Without either, `available` is false and `reason` explains what is missing. `reads` lists the records the assistant can look up for you, based on your role. `contextual` reports whether record and chart assistance is available in this workspace.',
    })
    .meta({ access: anyMember, errors: [401, 403, 404, 503] })
    .input(z.object({ params: organizationParamsSchema }))
    .output(assistantAvailabilitySchema),
  ask: endpoint
    .route({
      method: 'POST',
      path: `${path}/answers`,
      summary: 'Ask a question about your workspace',
      description:
        'Answers a question from the orders, issues, stock, fulfillment, customer profiles and returns you can see in this workspace. Luma reads current records for every question, with your access, and never changes anything. Citation markers in `content` link to the records the answer used, with their source and observation time. Send earlier turns in `history` for follow-up questions; Luma does not store conversations. Optional context rereads a selected record or exact chart filters before answering; it requires contextual assistance to be enabled for this workspace. Each answer is limited in reads, length and time; when a limit is reached, `outcome` is `incomplete`. Returns 503 with a reason when the assistant is unavailable here or the model fails, times out or returns nothing usable.',
    })
    .meta({
      access: requires('assistant.use'),
      errors: [400, 401, 403, 404, 503],
    })
    .input(
      z.object({ params: organizationParamsSchema, body: askAssistantSchema }),
    )
    .output(assistantAnswerSchema),
};
