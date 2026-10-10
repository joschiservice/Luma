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

/** A suspended membership keeps its role but has no access to the workspace until reactivated. */
export const membershipStatusSchema = z.enum(['active', 'suspended']);

export const membershipSchema = z.object({
  name: z.string().optional(),
  email: z.string().optional(),
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  userId: z.string().uuid(),
  role: roleReferenceSchema,
  status: membershipStatusSchema,
});

/** A workspace in the signed-in person's list, with their membership status in it. */
export const organizationAccessSchema = organizationSchema.extend({
  membershipStatus: membershipStatusSchema,
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

export const securityEventTypeSchema = z.enum([
  'sign-in.password',
  'sign-in.passkey',
  'sign-in.two-factor',
  'two-factor.enabled',
  'two-factor.disabled',
  'two-factor.backup-codes-regenerated',
  'passkey.added',
  'passkey.removed',
  'password.changed',
  'sessions.revoked',
  'sessions.revoked-by-staff',
]);

export const securityEventSchema = z.object({
  id: z.string().uuid(),
  type: securityEventTypeSchema,
  outcome: z.enum(['succeeded', 'failed']),
  /** Failure category, factor used, or revocation scope. Never a submitted value. */
  reason: z.string().nullable(),
  createdAt: z.string().datetime(),
  /** Cleared after 90 days, like the user agent the browser and system come from. */
  ipAddress: z.string().nullable(),
  browser: z.string().nullable(),
  os: z.string().nullable(),
  currentSession: z.boolean(),
  bySupport: z.boolean(),
});

export type SecurityEventResponse = z.infer<typeof securityEventSchema>;

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
  listSecurityEvents: endpoint
    .route({
      method: 'GET',
      path: '/v1/account/security-events',
      summary: 'List your recent security activity',
      description:
        'Returns sign-ins, failed sign-in attempts and security changes for your own account, newest first, 20 per page. Events are kept for one year; IP addresses and devices for 90 days.',
    })
    .meta({ errors: [...errors, 422] })
    .input(
      z.object({
        query: z.object({ cursor: z.string().max(200).optional() }),
      }),
    )
    .output(
      z.object({
        items: z.array(securityEventSchema),
        nextCursor: z.string().nullable(),
      }),
    ),
  listOrganizations: endpoint
    .route({
      method: 'GET',
      path: '/v1/organizations',
      summary: 'List your organizations',
      description:
        'Includes workspaces where your membership is suspended. Their `membershipStatus` is `suspended`, and their tenant routes return 403 until the membership is reactivated.',
    })
    .meta({ errors })
    .output(z.object({ items: z.array(organizationAccessSchema) })),
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
        'Requires `members.manage`. Only owners change ownership; others can only assign roles, and change members, whose permissions they hold. The last active owner cannot be demoted.',
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
      description: 'The last active owner cannot be removed or demoted.',
    })
    .meta({ access: requires('members.manage'), errors })
    .input(z.object({ params: memberParamsSchema, headers: commandHeaders }))
    .output(z.void()),
};
