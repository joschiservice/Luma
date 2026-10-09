import { z } from 'zod';

import { endpoint, organizationParamsSchema, requires } from '../common.js';
import {
  customerDetailSchema,
  customerListSchema,
  customerQuerySchema,
} from '../customers.js';

export const customersContract = {
  list: endpoint
    .route({
      method: 'GET',
      path: '/v1/organizations/{organizationId}/customers',
      summary: 'Browse customers',
      description:
        'List customer profiles imported from connected stores. Each profile belongs to one connection and source customer; profiles are never merged across stores, and names or email addresses do not establish identity. Name, email and phone are null unless the source shares contact details (`shared.contact`). `orderCount` and `amountSpent` are what the source reports. Search matches the name, email address, phone number and source customer ID. `externalId` with `connectionId` finds one source customer. `sources` lists each commerce connection and whether it shares customers with Luma. Results contain up to `limit` profiles (at most 50) with `totalCount` matches; nextCursor continues the same filters and sorting.',
    })
    .meta({ access: requires('customers.read'), errors: [400, 401, 404, 503] })
    .input(
      z.object({
        params: organizationParamsSchema,
        query: customerQuerySchema,
      }),
    )
    .output(customerListSchema),
  get: endpoint
    .route({
      method: 'GET',
      path: '/v1/organizations/{organizationId}/customers/{customerId}',
      summary: 'Inspect a customer',
      description:
        'Read one imported customer profile with its address, when the source shares addresses, and the connection it came from. Order history is read live through the connected app.',
    })
    .meta({ access: requires('customers.read'), errors: [401, 404, 503] })
    .input(
      z.object({
        params: organizationParamsSchema.extend({
          customerId: z.string().uuid(),
        }),
      }),
    )
    .output(customerDetailSchema),
};
