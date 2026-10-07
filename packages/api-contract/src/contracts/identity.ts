import { initContract } from '@ts-rest/core';
import { z } from 'zod';

import {
  anyMember,
  apiErrorSchema,
  dataRegionSchema,
  organizationParamsSchema,
  requires,
} from '../common.js';
import { roleReferenceSchema } from '../roles.js';

const c = initContract();

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
  role: roleReferenceSchema,
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
    role: roleReferenceSchema,
  }),
  /** Every permission the caller's role grants in this workspace. */
  permissions: z.array(z.string()),
  /** True for Owner and Admin, which also hold every installed app's permissions. */
  allAppPermissions: z.boolean(),
});

export type Membership = z.infer<typeof membershipSchema>;

export type TenantContextResponse = z.infer<typeof tenantContextSchema>;

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
      metadata: anyMember,
      summary: 'Resolve your organization access',
      description:
        'Returns your membership, role and effective permissions. Changes to your role apply on the next request.',
    },
    listMembers: {
      method: 'GET',
      path: '/v1/organizations/:organizationId/members',
      pathParams: organizationParamsSchema,
      responses: { 200: z.object({ items: z.array(membershipSchema) }) },
      metadata: anyMember,
      summary: 'List organization members',
    },
    addMember: {
      headers: z.object({ 'x-command-id': z.string().uuid().optional() }),
      method: 'POST',
      path: '/v1/organizations/:organizationId/members',
      pathParams: organizationParamsSchema,
      body: z
        .object({ userId: z.string().uuid(), roleId: z.string().min(1) })
        .strict(),
      responses: { 201: membershipSchema },
      metadata: requires('members.manage'),
      summary: 'Add a registered user to an organization',
      description:
        'Requires `members.manage`. Only owners can grant ownership, and others can only assign roles whose permissions they hold.',
    },
    updateMember: {
      headers: z.object({ 'x-command-id': z.string().uuid().optional() }),
      method: 'PATCH',
      path: '/v1/organizations/:organizationId/members/:memberId',
      pathParams: memberParamsSchema,
      body: z.object({ roleId: z.string().min(1) }).strict(),
      responses: { 200: membershipSchema },
      metadata: requires('members.manage'),
      summary: 'Change a member role',
      description:
        'Requires `members.manage`. Only owners change ownership; others can only assign roles, and change members, whose permissions they hold. The last owner cannot be demoted.',
    },
    removeMember: {
      headers: z.object({ 'x-command-id': z.string().uuid().optional() }),
      method: 'DELETE',
      path: '/v1/organizations/:organizationId/members/:memberId',
      pathParams: memberParamsSchema,
      body: c.noBody(),
      responses: { 204: c.noBody() },
      metadata: requires('members.manage'),
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
