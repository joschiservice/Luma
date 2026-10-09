import { z } from 'zod';

import {
  anyMember,
  dataRegionSchema,
  endpoint,
  type ErrorStatus,
  organizationParamsSchema,
  requires,
} from '../common.js';
import { roleReferenceSchema } from '../roles.js';

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

const errors = [401, 403, 404, 409, 503] as const satisfies ErrorStatus[];
const commandHeaders = z.object({
  'x-command-id': z.string().uuid().optional(),
});

export const identityContract = {
  listOrganizations: endpoint
    .route({
      method: 'GET',
      path: '/v1/organizations',
      summary: 'List your organizations',
    })
    .meta({ errors })
    .output(z.object({ items: z.array(organizationSchema) })),
  createOrganization: endpoint
    .route({
      method: 'POST',
      path: '/v1/organizations',
      successStatus: 201,
      summary: 'Create an organization',
      description:
        'Creates an EU organization with you as its owner. Other regions are unavailable.',
    })
    .meta({ errors: [...errors, 422] })
    .input(
      z.object({
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
      }),
    )
    .output(organizationSchema),
  context: endpoint
    .route({
      method: 'GET',
      path: '/v1/organizations/{organizationId}/context',
      summary: 'Resolve your organization access',
      description:
        'Returns your membership, role and effective permissions. Changes to your role apply on the next request.',
    })
    .meta({ access: anyMember, errors })
    .input(z.object({ params: organizationParamsSchema }))
    .output(tenantContextSchema),
  listMembers: endpoint
    .route({
      method: 'GET',
      path: '/v1/organizations/{organizationId}/members',
      summary: 'List organization members',
    })
    .meta({ access: anyMember, errors })
    .input(z.object({ params: organizationParamsSchema }))
    .output(z.object({ items: z.array(membershipSchema) })),
  addMember: endpoint
    .route({
      method: 'POST',
      path: '/v1/organizations/{organizationId}/members',
      successStatus: 201,
      summary: 'Add a registered user to an organization',
      description:
        'Requires `members.manage`. Only owners can grant ownership, and others can only assign roles whose permissions they hold.',
    })
    .meta({ access: requires('members.manage'), errors })
    .input(
      z.object({
        params: organizationParamsSchema,
        headers: commandHeaders,
        body: z
          .object({ userId: z.string().uuid(), roleId: z.string().min(1) })
          .strict(),
      }),
    )
    .output(membershipSchema),
  updateMember: endpoint
    .route({
      method: 'PATCH',
      path: '/v1/organizations/{organizationId}/members/{memberId}',
      summary: 'Change a member role',
      description:
        'Requires `members.manage`. Only owners change ownership; others can only assign roles, and change members, whose permissions they hold. The last owner cannot be demoted.',
    })
    .meta({ access: requires('members.manage'), errors })
    .input(
      z.object({
        params: memberParamsSchema,
        headers: commandHeaders,
        body: z.object({ roleId: z.string().min(1) }).strict(),
      }),
    )
    .output(membershipSchema),
  removeMember: endpoint
    .route({
      method: 'DELETE',
      path: '/v1/organizations/{organizationId}/members/{memberId}',
      successStatus: 204,
      summary: 'Remove an organization member',
      description: 'The last owner cannot be removed or demoted.',
    })
    .meta({ access: requires('members.manage'), errors })
    .input(z.object({ params: memberParamsSchema, headers: commandHeaders }))
    .output(z.void()),
};
