import { initContract } from '@ts-rest/core';
import { z } from 'zod';

import {
  apiErrorSchema,
  organizationParamsSchema,
  requires,
} from '../common.js';
import {
  customerDetailSchema,
  customerListSchema,
  customerQuerySchema,
} from '../customers.js';

const c = initContract();

export const customersContract = c.router({
  list: {
    method: 'GET',
    metadata: requires('customers.read'),
    path: '/v1/organizations/:organizationId/customers',
    pathParams: organizationParamsSchema,
    query: customerQuerySchema,
    responses: {
      200: customerListSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: 'Browse customers',
    description:
      'List customer profiles imported from connected stores. Each profile belongs to one connection and source customer; profiles are never merged across stores, and names or email addresses do not establish identity. Name, email and phone are null unless the source shares contact details (`shared.contact`). `orderCount` and `amountSpent` are what the source reports. Search matches the name, email address, phone number and source customer ID. `externalId` with `connectionId` finds one source customer. `sources` lists each commerce connection and whether it shares customers with Luma. Results contain up to `limit` profiles (at most 50) with `totalCount` matches; nextCursor continues the same filters and sorting.',
  },
  get: {
    method: 'GET',
    metadata: requires('customers.read'),
    path: '/v1/organizations/:organizationId/customers/:customerId',
    pathParams: organizationParamsSchema.extend({
      customerId: z.string().uuid(),
    }),
    responses: {
      200: customerDetailSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: 'Inspect a customer',
    description:
      'Read one imported customer profile with its address, when the source shares addresses, and the connection it came from. Order history is read live through the connected app.',
  },
});
