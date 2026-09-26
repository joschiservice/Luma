import { initContract } from '@ts-rest/core';
import { z } from 'zod';

import {
  apiErrorSchema,
  dataRegionSchema,
  organizationParamsSchema,
} from '../common.js';

const c = initContract();

export const roleSchema = z.enum(['owner', 'admin', 'member']);

export const organizationSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  dataRegion: dataRegionSchema,
  status: z.enum(['active', 'suspended', 'closed']),
});

export const membershipSchema = z.object({
  name: z.string().optional(),
  email: z.string().optional(),
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  userId: z.string().uuid(),
  role: roleSchema,
});

export const tenantContextSchema = z.object({
  tenantId: z.string().uuid(),
  dataRegion: z.literal('EU'),
  requestId: z.string(),
  actor: z.object({
    type: z.literal('user'),
    id: z.string().uuid(),
    initiatingUserId: z.string().uuid(),
    sessionId: z.string().uuid(),
    membershipId: z.string().uuid(),
    role: roleSchema,
  }),
});

export const memberParamsSchema = organizationParamsSchema.extend({
  memberId: z.string().uuid(),
});

export const identityContract = c.router(
  {
    listOrganizations: {
      method: 'GET',
      path: '/v1/organizations',
      responses: { 200: z.object({ items: z.array(organizationSchema) }) },
      summary: 'List your organizations',
    },
    createOrganization: {
      method: 'POST',
      path: '/v1/organizations',
      body: z
        .object({
          name: z.string().trim().min(1).max(200),
          slug: z
            .string()
            .min(1)
            .max(100)
            .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
          dataRegion: dataRegionSchema.optional(),
        })
        .strict(),
      responses: { 201: organizationSchema, 422: apiErrorSchema },
      summary: 'Create an organization',
      description:
        'Creates an EU organization with you as its owner. Other regions are unavailable.',
    },
    context: {
      method: 'GET',
      path: '/v1/organizations/:organizationId/context',
      pathParams: organizationParamsSchema,
      responses: { 200: tenantContextSchema },
      summary: 'Resolve your organization access',
    },
    listMembers: {
      method: 'GET',
      path: '/v1/organizations/:organizationId/members',
      pathParams: organizationParamsSchema,
      responses: { 200: z.object({ items: z.array(membershipSchema) }) },
      summary: 'List organization members',
    },
    addMember: {
      method: 'POST',
      path: '/v1/organizations/:organizationId/members',
      pathParams: organizationParamsSchema,
      body: z.object({ userId: z.string().uuid(), role: roleSchema }).strict(),
      responses: { 201: membershipSchema },
      summary: 'Add a registered user to an organization',
      description:
        'Owners and admins can add users. Only owners can grant ownership.',
    },
    updateMember: {
      headers: z.object({ 'x-command-id': z.string().uuid().optional() }),
      method: 'PATCH',
      path: '/v1/organizations/:organizationId/members/:memberId',
      pathParams: memberParamsSchema,
      body: z.object({ role: roleSchema }).strict(),
      responses: { 200: membershipSchema },
      summary: 'Change a member role',
    },
    removeMember: {
      headers: z.object({ 'x-command-id': z.string().uuid().optional() }),
      method: 'DELETE',
      path: '/v1/organizations/:organizationId/members/:memberId',
      pathParams: memberParamsSchema,
      body: c.noBody(),
      responses: { 204: c.noBody() },
      summary: 'Remove an organization member',
      description: 'The last owner cannot be removed or demoted.',
    },
  },
  {
    commonResponses: {
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      503: apiErrorSchema,
    },
  },
);
