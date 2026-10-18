import { z } from 'zod';

import { endpoint, organizationParamsSchema, requires } from '../common.js';
import {
  customerErasureInputSchema,
  customerErasureSchema,
  customerErasureTargetSchema,
} from '../customers.js';

export const customerErasuresContract = {
  create: endpoint
    .route({
      method: 'POST',
      path: '/v1/organizations/{organizationId}/customer-erasures',
      summary: 'Erase a customer',
      description:
        "Erases one customer of a connected store or ERP for a data-subject request: the imported profile, its order links and order addresses, and the customer's inbox data. Inbox erasure removes message text and attachment content, replaces the customer's address and name on messages, replies and threads, clears their subjects and removes the name and email from party facts. Use `emails` for further addresses of the customer that Luma may hold. Works when Luma imported no profile, and later reads never import the customer or their orders' addresses again. Unsent replies to the customer are withheld. Data in the connected system and in provider observations is not changed. Mailbox rules for the customer's address are removed. The result counts the profiles removed, messages erased, threads and replies changed and rules removed. Reuse the command ID for a retry; the same ID for another customer answers 409.",
    })
    .meta({
      access: requires('customers.erase'),
      errors: [400, 401, 403, 404, 409, 503],
    })
    .input(
      z.object({
        params: organizationParamsSchema,
        body: customerErasureInputSchema,
      }),
    )
    .output(customerErasureSchema),
  preview: endpoint
    .route({
      method: 'POST',
      path: '/v1/organizations/{organizationId}/customer-erasures/preview',
      summary: 'Preview a customer erasure',
      description:
        'Counts what erasing the customer would remove or change now, with the same matching as the erasure, without changing anything. Show it before asking for confirmation. Counts can change before the erasure if new data arrives.',
    })
    .meta({
      access: requires('customers.erase'),
      errors: [400, 401, 403, 404, 503],
    })
    .input(
      z.object({
        params: organizationParamsSchema,
        body: customerErasureTargetSchema,
      }),
    )
    .output(customerErasureSchema),
};
