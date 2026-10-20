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
import { supportInspectionSchema } from '../settings.js';

export const organizationSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  dataRegion: dataRegionSchema,
  status: z.enum(['active', 'suspended', 'closed']),
});

/** A suspended membership keeps its role but has no access to the workspace until reactivated. */
const membershipStatusSchema = z.enum(['active', 'suspended']);

const membershipSchema = z.object({
  name: z.string().optional(),
  email: z.string().optional(),
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  userId: z.string().uuid(),
  role: roleReferenceSchema,
  status: membershipStatusSchema,
});

/** A workspace in the signed-in person's list, with their membership status in it. */
const organizationAccessSchema = organizationSchema.extend({
  membershipStatus: membershipStatusSchema,
  /** For a closed workspace, the announced date its data is deleted; null until scheduled. */
  dataDeletionAt: z.string().datetime().nullable(),
  /** For a closed workspace, when its data was deleted; null until then. */
  dataDeletedAt: z.string().datetime().nullable(),
});

const tenantContextSchema = z.object({
  tenantId: z.string().uuid(),
  dataRegion: dataRegionSchema,
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
  /** Present when Luma support views the workspace as this member; every change is refused. */
  supportView: z
    .object({
      id: z.string().uuid(),
      mode: z.enum(['consent', 'emergency']),
      expiresAt: z.string().datetime(),
    })
    .nullable()
    .optional(),
  /**
   * Present when a personal API app made the request: `permissions` are then the app's scopes
   * that the member's role still grants, and `actor.sessionId` is the token's credential ID.
   */
  apiApp: z
    .object({ id: z.string().uuid(), scopes: z.array(z.string()) })
    .nullable()
    .optional(),
});

const supportViewEndReasonSchema = z.enum([
  'ended',
  'expired',
  'consent_revoked',
  'staff_access_revoked',
  'replaced',
]);

/** The support view this browser holds, if any. */
const supportViewStateSchema = z.discriminatedUnion('active', [
  z.object({
    active: z.literal(false),
    /** Why the view this browser held ended, when it just ended. */
    endReason: supportViewEndReasonSchema.nullable(),
  }),
  z.object({
    active: z.literal(true),
    id: z.string().uuid(),
    mode: z.enum(['consent', 'emergency']),
    expiresAt: z.string().datetime(),
    workspace: z.object({ id: z.string().uuid(), name: z.string() }),
    member: z.object({
      id: z.string().uuid(),
      name: z.string(),
      email: z.string(),
    }),
  }),
]);

export type SupportViewState = z.infer<typeof supportViewStateSchema>;

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
  'password.reset',
  'sessions.revoked',
  'sessions.revoked-by-staff',
  'account.disabled',
  'account.enabled',
  'account.deletion-scheduled',
  'account.restored',
  'support-inspection.requested',
  'support-inspection.approved',
  'support-inspection.declined',
  'support-inspection.expired',
  'support-inspection.revoked',
  'support-inspection.emergency-opened',
]);

const securityEventSchema = z.object({
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

const memberParamsSchema = organizationParamsSchema.extend({
  memberId: z.string().uuid(),
});

const errors = [401, 403, 404, 409, 503] as const satisfies ErrorStatus[];
const commandHeaders = z.object({
  'x-command-id': z.string().uuid().optional(),
});

export const identityContract = {
  supportView: endpoint
    .route({
      method: 'GET',
      path: '/v1/support-view',
      summary: 'Read the Luma support view in this browser',
      description:
        'Returns the read-only support view this browser holds: the workspace, the member it shows and when it ends. Inactive when there is none or it ended, with the reason it just ended.',
    })
    .meta({ errors: [503] })
    .output(supportViewStateSchema),
  redeemSupportView: endpoint
    .route({
      method: 'POST',
      path: '/v1/support-view/redeem',
      summary: 'Open a Luma support view',
      description:
        'Exchanges the single-use token from a staff console link, within two minutes, for a support view cookie. While the cookie is present, workspace routes show the viewed member’s access read-only and refuse every change.',
    })
    .meta({ errors: [403, 404, 503] })
    .input(
      z.object({
        body: z
          .object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
          .strict(),
      }),
    )
    .output(z.object({ workspaceId: z.string().uuid() })),
  endSupportView: endpoint
    .route({
      method: 'POST',
      path: '/v1/support-view/end',
      successStatus: 204,
      summary: 'End the Luma support view',
      description:
        'Ends the support view this browser holds, records its end and clears its cookie.',
    })
    .meta({ errors: [403, 503] })
    .output(z.void()),
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
  listSupportInspections: endpoint
    .route({
      method: 'GET',
      path: '/v1/account/support-inspections',
      summary: 'List Luma support requests for your account',
      description:
        'Returns requests from Luma support to inspect your account, and approved inspections that are still open, newest first. Inspection shows your workspaces and roles, sign-in factor status, active sessions and security activity; it never shows passwords or factor secrets.',
    })
    .meta({ errors })
    .output(z.object({ items: z.array(supportInspectionSchema) })),
  decideSupportInspection: endpoint
    .route({
      method: 'POST',
      path: '/v1/account/support-inspections/{requestId}',
      summary: 'Approve or decline a Luma support request for your account',
      description:
        'Approving lets the support team member who asked inspect your account for thirty minutes from now. Repeating the same answer returns the current list; a request that lapsed or got another answer returns 409.',
    })
    .meta({ errors })
    .input(
      z.object({
        params: z.object({ requestId: z.string().uuid() }),
        body: z.object({ decision: z.enum(['approve', 'decline']) }).strict(),
      }),
    )
    .output(z.object({ items: z.array(supportInspectionSchema) })),
  revokeSupportInspection: endpoint
    .route({
      method: 'POST',
      path: '/v1/account/support-inspections/{requestId}/revoke',
      summary: 'End an approved Luma support inspection of your account',
      description:
        'Ends approved access now; the support team’s next read is refused. Emergency access can’t be revoked. Revoking again returns the current list; access that already ended returns 409.',
    })
    .meta({ errors })
    .input(z.object({ params: z.object({ requestId: z.string().uuid() }) }))
    .output(z.object({ items: z.array(supportInspectionSchema) })),
  setLanguage: endpoint
    .route({
      method: 'PUT',
      path: '/v1/account/language',
      successStatus: 204,
      summary: 'Set your email language',
      description:
        'Stores the interface language Luma uses for email to you, such as invitations, notifications and account notices. The web app calls this after you pick a language.',
    })
    .meta({ errors: [401, 403, 503] })
    .input(z.object({ body: z.object({ language: z.enum(['en', 'de']) }) }))
    .output(z.void()),
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
        'Creates a workspace in this cell’s confirmed data region with you as its owner. Other regions are rejected.',
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
    .meta({ publicApi: true, access: anyMember, errors })
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
