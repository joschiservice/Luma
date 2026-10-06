import { initContract } from '@ts-rest/core';

import {
  askAssistantSchema,
  assistantAnswerSchema,
  assistantAvailabilitySchema,
} from '../assistant.js';
import { apiErrorSchema, organizationParamsSchema } from '../common.js';

const c = initContract();
const path = '/v1/organizations/:organizationId/assistant';

export const assistantContract = c.router({
  availability: {
    method: 'GET',
    path,
    pathParams: organizationParamsSchema,
    responses: {
      200: assistantAvailabilitySchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: 'Check whether you can ask Luma here',
    description:
      'Members can check this. Asking Luma needs an EU model route with zero data retention. When none is configured, `available` is false and `reason` explains what whoever runs the server must set up. `reads` lists the records the assistant can look up.',
  },
  ask: {
    method: 'POST',
    path: `${path}/answers`,
    pathParams: organizationParamsSchema,
    body: askAssistantSchema,
    responses: {
      200: assistantAnswerSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: 'Ask a question about your workspace',
    description:
      'Answers a question from the orders, issues, stock, fulfillment and returns you can see in this workspace. Luma reads current records for every question, with your access, and never changes anything. Citation markers in `content` link to the records the answer used, with their source and observation time. Send earlier turns in `history` for follow-up questions; Luma does not store conversations. Each answer is limited in reads, length and time; when a limit is reached, `outcome` is `incomplete`. Returns 503 with a reason when the assistant is unavailable here or the model fails, times out or returns nothing usable.',
  },
});
