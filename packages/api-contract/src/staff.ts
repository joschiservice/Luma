import { z } from 'zod';

import { endpoint, type ErrorStatus } from './common.js';
import { securityEventTypeSchema } from './contracts/identity.js';

export const staffPermissionSchema = z.enum([
  'staff.directory.read',
  'staff.workspace.inspect',
  'staff.sessions.revoke',
  'staff.audit.read',
  'staff.accounts.inspect',
  'staff.memberships.manage',
  'staff.view-as',
  'staff.view-as.emergency',
  'staff.accounts.manage',
  'staff.accounts.delete',
]);

/** Why staff disabled an account. Staff see it; the customer never does. */
export const staffAccountDisableCategorySchema = z.enum([
  'compromised',
  'abuse',
  'fraud',
  'legal_request',
  'other',
]);

/** Why staff scheduled an account for deletion; kept with the erasure receipt. */
export const staffAccountDeletionCategorySchema = z.enum([
  'customer_request',
  'gdpr_erasure',
  'abuse',
  'inactivity',
]);

/** The request a deletion fulfils, such as a ticket ID. Must not contain personal data. */
const staffDeletionReferenceSchema = z.string().trim().min(3).max(200);

/** A suspended membership keeps its role and the account; it has no access to the workspace. */
const staffMembershipStatusSchema = z.enum(['active', 'suspended']);

const staffWorkspaceSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  status: z.string(),
  dataRegion: z.string(),
});

const staffUserSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  email: z.string(),
});

const staffAccessSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  reason: z.string(),
  expiresAt: z.string().datetime(),
});

const staffDetailSchema = z.object({
  membersTruncated: z.boolean(),
  connectionsTruncated: z.boolean(),
  workspace: staffWorkspaceSchema,
  members: z.array(
    z.object({
      id: z.string().uuid(),
      userId: z.string().uuid(),
      name: z.string(),
      email: z.string(),
      role: z.string(),
      /** Holds the Owner role, active or suspended. */
      owner: z.boolean(),
      status: staffMembershipStatusSchema,
      suspendedAt: z.string().datetime().nullable(),
      /**
       * Who suspended the membership: Luma staff, someone in the workspace, or the account's
       * scheduled deletion.
       */
      suspendedBy: z.enum(['staff', 'customer', 'account_deletion']).nullable(),
      /** The person belongs to no other workspace; banning the workspace may disable them too. */
      onlyWorkspace: z.boolean(),
      /** Luma staff disabled the person's account, so no workspace accepts them. */
      accountDisabled: z.boolean(),
    }),
  ),
  connections: z.array(
    z.object({
      id: z.string().uuid(),
      provider: z.string(),
      status: z.string(),
      lastSyncAt: z.string().datetime().nullable(),
    }),
  ),
  /** Whether the workspace allows read-only support views, and a pending request for it. */
  supportAccess: z.object({
    allowedUntil: z.string().datetime().nullable(),
    request: z
      .object({
        id: z.string().uuid(),
        durationHours: z.union([z.literal(24), z.literal(72), z.literal(168)]),
        requestedAt: z.string().datetime(),
        expiresAt: z.string().datetime(),
      })
      .nullable(),
  }),
});

const staffReasonSchema = z.string().trim().min(10).max(500);

export const staffConfigSchema = z.object({
  mode: z.enum(['local', 'google']),
  providerId: z.literal('google').nullable(),
});

export const staffSessionSchema = z.object({
  user: staffUserSchema,
  permissions: z.array(staffPermissionSchema),
});

export const staffDirectorySchema = z.object({
  usersTruncated: z.boolean(),
  workspacesTruncated: z.boolean(),
  users: z.array(staffUserSchema),
  workspaces: z.array(staffWorkspaceSchema),
});

export const staffAccessGrantSchema = staffAccessSchema;

export const staffWorkspaceDetailSchema = staffDetailSchema;

export const staffRevokeSessionsResultSchema = z.object({
  commandId: z.string().uuid(),
  revokedSessions: z.number().int().nonnegative(),
  completedAt: z.string().datetime(),
});

/** The receipt of an account disable or enable; retries return the original. */
export const staffAccountChangeSchema = z.object({
  commandId: z.string().uuid(),
  status: z.enum(['disabled', 'enabled']),
  /** Sessions ended by disabling; enabling ends none. */
  revokedSessions: z.number().int().nonnegative(),
  completedAt: z.string().datetime(),
});

/** The receipt of an account deletion command; retries return the original. */
export const staffAccountDeletionChangeSchema = z.object({
  commandId: z.string().uuid(),
  deletionId: z.string().uuid(),
  /** `erasing`: erasure without the restore window was requested; it can't be restored. */
  status: z.enum(['scheduled', 'restored', 'erasing']),
  /** When the account is erased. */
  eraseAfter: z.string().datetime(),
  /** Sessions ended by this command. */
  revokedSessions: z.number().int().nonnegative(),
  completedAt: z.string().datetime(),
});

/** The receipt of a membership suspension or reactivation; retries return the original. */
export const staffMembershipChangeSchema = z.object({
  commandId: z.string().uuid(),
  membershipId: z.string().uuid(),
  status: staffMembershipStatusSchema,
  /** Whether the suspension left the workspace without an active owner. */
  lastActiveOwner: z.boolean(),
  completedAt: z.string().datetime(),
});

/** Emergency support views need one of these reasons and an external reference. */
const staffEmergencyCategorySchema = z.enum([
  'security_incident',
  'legal_request',
]);

/** A started support view: open `url` in a new tab within two minutes. */
export const staffSupportViewSchema = z.object({
  id: z.string().uuid(),
  expiresAt: z.string().datetime(),
  /** The customer app with a single-use token in the fragment; valid until `handoffExpiresAt`. */
  url: z.string().url(),
  handoffExpiresAt: z.string().datetime(),
});

export const staffSupportAccessRequestSchema = z.object({
  id: z.string().uuid(),
  durationHours: z.union([z.literal(24), z.literal(72), z.literal(168)]),
  requestedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});

const timestamp = z.string().datetime();
const staffPersonSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  member: z.boolean().nullable(),
});
/** Counts are exact up to the cap; `capped` marks a count that reached it. */
const staffCountSchema = z.object({
  count: z.number().int().nonnegative(),
  capped: z.boolean(),
});

/** Workspace health metadata, codes and counts. Every list is bounded and marks truncation. */
export const staffWorkspaceHealthSchema = z.object({
  readAt: timestamp,
  settings: z
    .object({ timezone: z.string(), alwaysRequireApproval: z.boolean() })
    .nullable(),
  sync: z.object({
    streams: z.array(
      z.object({
        id: z.string().uuid(),
        connectionId: z.string().uuid(),
        recordType: z.string(),
        phase: z.string(),
        scan: z.string().nullable(),
        paused: z.boolean(),
        blocked: z.string().nullable(),
        attempts: z.number().int().nonnegative(),
        errorCode: z.string().nullable(),
        errorMessage: z.string().nullable(),
        errorAt: timestamp.nullable(),
        failingSince: timestamp.nullable(),
        lastSuccessAt: timestamp.nullable(),
      }),
    ),
    streamsTruncated: z.boolean(),
    runs: z.array(
      z.object({
        id: z.string().uuid(),
        connectionId: z.string().uuid(),
        recordType: z.string(),
        kind: z.string(),
        trigger: z.string(),
        outcome: z.string(),
        startedAt: timestamp,
        finishedAt: timestamp.nullable(),
        records: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        errors: z.number().int().nonnegative(),
      }),
    ),
    runsTruncated: z.boolean(),
  }),
  connections: z.object({
    items: z.array(
      z.object({
        id: z.string().uuid(),
        provider: z.string(),
        status: z.string(),
        version: z.number().int(),
        credentialVersion: z.number().int().nullable(),
      }),
    ),
    itemsTruncated: z.boolean(),
    events: z.array(
      z.object({
        connectionId: z.string().uuid(),
        version: z.number().int(),
        event: z.string(),
        status: z.string(),
        credentialVersion: z.number().int(),
        actor: staffPersonSchema,
        createdAt: timestamp,
      }),
    ),
    eventsTruncated: z.boolean(),
    readChecks: z.array(
      z.object({
        connectionId: z.string().uuid(),
        capability: z.string(),
        succeeded: z.boolean(),
        errorCode: z.string().nullable(),
        observedAt: timestamp,
      }),
    ),
    readChecksTruncated: z.boolean(),
  }),
  execution: z.object({
    unknown: staffCountSchema,
    failed: staffCountSchema,
    actions: z.array(
      z.object({
        id: z.string().uuid(),
        proposalId: z.string().uuid(),
        state: z.enum(['unknown', 'failed']),
        capability: z.string().nullable(),
        connectionId: z.string().uuid().nullable(),
        dispatch: z.string().nullable(),
        businessOutcome: z.string().nullable(),
        updatedAt: timestamp,
      }),
    ),
    actionsTruncated: z.boolean(),
    failures: z.array(
      z.object({
        id: z.string().uuid(),
        proposalId: z.string().uuid(),
        phase: z.string().nullable(),
        code: z.string().nullable(),
        retry: z.string().nullable(),
        effect: z.string().nullable(),
        createdAt: timestamp,
      }),
    ),
    failuresTruncated: z.boolean(),
  }),
  workflows: z.object({
    steps: z.array(
      z.object({
        runId: z.string().uuid(),
        definitionId: z.string(),
        stepId: z.string(),
        kind: z.string().nullable(),
        state: z.enum(['waiting', 'failed', 'inconclusive', 'escalated']),
        recordedAt: timestamp.nullable(),
      }),
    ),
    stepsTruncated: z.boolean(),
    awaitingAdmission: staffCountSchema.extend({
      oldestTriggeredAt: timestamp.nullable(),
    }),
    activations: z.array(
      z.object({
        id: z.string().uuid(),
        definitionId: z.string(),
        principal: staffPersonSchema,
        createdAt: timestamp,
      }),
    ),
    activationsTruncated: z.boolean(),
  }),
  cases: z.object({
    open: z.number().int().nonnegative(),
    byState: z.array(
      z.object({ state: z.string(), count: z.number().int().nonnegative() }),
    ),
    awaitingApproval: z.number().int().nonnegative(),
    reviewRequired: z.number().int().nonnegative(),
  }),
  mail: z.object({
    failed: staffCountSchema,
    items: z.array(
      z.object({
        id: z.string().uuid(),
        kind: z.string(),
        attempts: z.number().int().nonnegative(),
        createdAt: timestamp,
        firstAttemptAt: timestamp.nullable(),
      }),
    ),
    itemsTruncated: z.boolean(),
  }),
  apps: z.array(
    z.object({
      appId: z.string(),
      status: z.string(),
      version: z.number().int(),
      appVersion: z.string().nullable(),
      updatedAt: timestamp,
    }),
  ),
  appsTruncated: z.boolean(),
});

/** An access history position: the event time with microseconds and its ID. */
const staffAccessHistoryCursorSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );

export const staffAccessHistorySchema = z.object({
  events: z.array(
    z.object({
      id: z.string().uuid(),
      type: z.string(),
      targetId: z.string(),
      actor: staffPersonSchema,
      subject: staffPersonSchema.nullable(),
      summary: z.string().nullable(),
      createdAt: timestamp,
    }),
  ),
  nextCursor: staffAccessHistoryCursorSchema.nullable(),
});

/** A staff audit position: the entry time with microseconds and its sequence number. */
const staffAuditCursorSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z_\d{1,19}$/);

/** Optional audit filters. Staff member and account accept an ID or an exact email address. */
const staffAuditQuerySchema = z
  .object({
    staff: z.string().trim().min(1).max(320).optional(),
    workspace: z.string().uuid().optional(),
    account: z.string().trim().min(1).max(320).optional(),
    event: z
      .string()
      .regex(/^[a-z][a-z0-9.-]{0,99}$/)
      .optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    cursor: staffAuditCursorSchema.optional(),
  })
  .refine((query) => !query.from || !query.to || query.from < query.to, {
    message: 'The start of the time range must be before its end.',
    path: ['to'],
  });

export const staffAuditPageSchema = z.object({
  entries: z.array(
    z.object({
      sequence: z.string().regex(/^\d{1,19}$/),
      createdAt: z.string().datetime(),
      event: z.string(),
      outcome: z.enum(['succeeded', 'failed']),
      requestId: z.string(),
      reason: z.string().nullable(),
      details: z.record(z.string(), z.unknown()),
      staff: z
        .object({
          id: z.string().uuid(),
          name: z.string().nullable(),
          email: z.string().nullable(),
        })
        .nullable(),
      workspace: z
        .object({ id: z.string().uuid(), name: z.string().nullable() })
        .nullable(),
      account: z
        .object({
          id: z.string().uuid(),
          name: z.string().nullable(),
          email: z.string().nullable(),
        })
        .nullable(),
    }),
  ),
  nextCursor: staffAuditCursorSchema.nullable(),
});

export const staffAccountAccessSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  reason: z.string(),
  expiresAt: z.string().datetime(),
});

export const staffAccountDetailSchema = z.object({
  account: z.object({
    id: z.string().uuid(),
    name: z.string(),
    email: z.string(),
    createdAt: z.string().datetime(),
  }),
  /** Present while Luma staff have the account disabled. */
  disabled: z
    .object({
      at: z.string().datetime(),
      category: staffAccountDisableCategorySchema,
      reason: z.string(),
      /** The staff member's current name; null when they no longer exist. */
      byName: z.string().nullable(),
    })
    .nullable(),
  /** Present while the account is scheduled for deletion; it is disabled until then. */
  deletion: z
    .object({
      id: z.string().uuid(),
      scheduledAt: z.string().datetime(),
      eraseAfter: z.string().datetime(),
      category: staffAccountDeletionCategorySchema,
      reference: z.string(),
      /** The staff member's current name; null when they no longer exist. */
      byName: z.string().nullable(),
      /** Set when erasure without the restore window was requested; restore is then refused. */
      eraseRequestedAt: z.string().datetime().nullable(),
    })
    .nullable(),
  security: z.object({
    twoFactorEnabled: z.boolean(),
    passkeys: z.number().int().nonnegative(),
  }),
  workspacesTruncated: z.boolean(),
  workspaces: z.array(
    z.object({
      id: z.string().uuid(),
      name: z.string(),
      slug: z.string(),
      status: z.string(),
      dataRegion: z.string(),
      role: z.string(),
      customRoleName: z.string().nullable(),
      membershipStatus: staffMembershipStatusSchema,
      joinedAt: z.string().datetime(),
    }),
  ),
  sessionsTruncated: z.boolean(),
  sessions: z.array(
    z.object({
      id: z.string().uuid(),
      createdAt: z.string().datetime(),
      expiresAt: z.string().datetime(),
      lastActiveAt: z.string().datetime().nullable(),
      ipAddress: z.string().nullable(),
      browser: z.string().nullable(),
      os: z.string().nullable(),
    }),
  ),
});

export const staffAccountSecurityEventsSchema = z.object({
  items: z.array(
    z.object({
      id: z.string().uuid(),
      type: securityEventTypeSchema,
      outcome: z.enum(['succeeded', 'failed']),
      reason: z.string().nullable(),
      createdAt: z.string().datetime(),
      sessionId: z.string().uuid().nullable(),
      ipAddress: z.string().nullable(),
      browser: z.string().nullable(),
      os: z.string().nullable(),
      requestId: z.string(),
      staffCommandId: z.string().uuid().nullable(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
const workspaceParams = z.object({ workspaceId: z.string().uuid() });
const accountParams = z.object({ userId: z.string().uuid() });
const errors = [400, 401, 403, 404, 409, 503] as const satisfies ErrorStatus[];

/** Dedicated staff API contract; customer routes do not include these capabilities. */
export const staffContract = {
  config: endpoint
    .route({
      method: 'GET',
      path: '/v1/staff/config',
      summary: 'Get the staff sign-in method',
    })
    .meta({ errors })
    .output(staffConfigSchema),
  session: endpoint
    .route({
      method: 'GET',
      path: '/v1/staff/session',
      summary: 'Resolve current staff access',
    })
    .meta({ errors })
    .output(staffSessionSchema),
  directory: endpoint
    .route({
      method: 'GET',
      path: '/v1/staff/directory',
      summary: 'Search the support directory',
    })
    .meta({ errors })
    .input(
      z.object({
        query: z.object({ query: z.string().trim().min(3).max(100) }),
      }),
    )
    .output(staffDirectorySchema),
  grantAccess: endpoint
    .route({
      method: 'POST',
      path: '/v1/staff/workspaces/{workspaceId}/access',
      successStatus: 201,
      summary: 'Open time-limited workspace support access',
    })
    .meta({ errors })
    .input(
      z.object({
        params: workspaceParams,
        body: z.object({ reason: staffReasonSchema }).strict(),
      }),
    )
    .output(staffAccessSchema),
  workspace: endpoint
    .route({
      method: 'GET',
      path: '/v1/staff/workspaces/{workspaceId}',
      summary: 'Inspect a workspace using a current support grant',
    })
    .meta({ errors })
    .input(
      z.object({
        params: workspaceParams,
        query: z.object({ grantId: z.string().uuid() }),
      }),
    )
    .output(staffDetailSchema),
  health: endpoint
    .route({
      method: 'GET',
      path: '/v1/staff/workspaces/{workspaceId}/health',
      summary: 'Read workspace health using a current support grant',
      description:
        'Returns sync, connection, execution, workflow, case, mail, app and settings metadata as codes and counts. Lists hold the most recent 20 entries and mark truncation. Provider credentials, payloads and customer data are never included. Each read is audited.',
    })
    .meta({ errors })
    .input(
      z.object({
        params: workspaceParams,
        query: z.object({ grantId: z.string().uuid() }),
      }),
    )
    .output(staffWorkspaceHealthSchema),
  accessHistory: endpoint
    .route({
      method: 'GET',
      path: '/v1/staff/workspaces/{workspaceId}/access-history',
      summary: 'List workspace access changes using a current support grant',
      description:
        'Lists member, invitation, role, policy and workspace changes, newest first, 50 per page. Pass `nextCursor` as `cursor` for older events. Each read is audited.',
    })
    .meta({ errors })
    .input(
      z.object({
        params: workspaceParams,
        query: z.object({
          grantId: z.string().uuid(),
          cursor: staffAccessHistoryCursorSchema.optional(),
        }),
      }),
    )
    .output(staffAccessHistorySchema),
  audit: endpoint
    .route({
      method: 'GET',
      path: '/v1/staff/audit',
      summary: 'Review the staff audit log',
      description:
        'Lists staff sign-ins, searches, support grants, reads and commands, newest first, 50 per page. Filter by staff member, workspace, account, event and time range; pass `nextCursor` as `cursor` for older entries. Requires `staff.audit.read`. Each read is itself audited.',
    })
    .meta({ errors })
    .input(z.object({ query: staffAuditQuerySchema }))
    .output(staffAuditPageSchema),
  revokeSessions: endpoint
    .route({
      method: 'POST',
      path: '/v1/staff/workspaces/{workspaceId}/users/{userId}/revoke-sessions',
      summary: 'Revoke all customer sessions',
      description:
        'Revokes sessions across every workspace belonging to the user. Requires recent staff authentication and explicit acknowledgement. Repeated command IDs return the original receipt.',
    })
    .meta({ errors })
    .input(
      z.object({
        params: workspaceParams.extend({ userId: z.string().uuid() }),
        body: z
          .object({
            grantId: z.string().uuid(),
            reason: staffReasonSchema,
            commandId: z.string().uuid(),
            acknowledgeGlobalEffect: z.literal(true),
          })
          .strict(),
      }),
    )
    .output(staffRevokeSessionsResultSchema),
  suspendMembership: endpoint
    .route({
      method: 'POST',
      path: '/v1/staff/workspaces/{workspaceId}/users/{userId}/suspend-membership',
      summary: 'Suspend a workspace membership',
      description:
        'Removes the person’s access to this workspace only. The account, its other workspaces and the membership’s role are kept. Workflows acting as the person pause. Suspending the only active owner requires `acknowledgeLastOwner`. Requires `staff.memberships.manage` and recent staff authentication. Repeated command IDs return the original receipt; reusing one for another request returns 409.',
    })
    .meta({ errors })
    .input(
      z.object({
        params: workspaceParams.extend({ userId: z.string().uuid() }),
        body: z
          .object({
            grantId: z.string().uuid(),
            reason: staffReasonSchema,
            commandId: z.string().uuid(),
            acknowledgeLastOwner: z.boolean().default(false),
          })
          .strict(),
      }),
    )
    .output(staffMembershipChangeSchema),
  reactivateMembership: endpoint
    .route({
      method: 'POST',
      path: '/v1/staff/workspaces/{workspaceId}/users/{userId}/reactivate-membership',
      summary: 'Reactivate a suspended workspace membership',
      description:
        'Restores access with the role the membership had. Paused workflows acting as the person continue. Requires `staff.memberships.manage` and recent staff authentication. Repeated command IDs return the original receipt; reusing one for another request returns 409.',
    })
    .meta({ errors })
    .input(
      z.object({
        params: workspaceParams.extend({ userId: z.string().uuid() }),
        body: z
          .object({
            grantId: z.string().uuid(),
            reason: staffReasonSchema,
            commandId: z.string().uuid(),
          })
          .strict(),
      }),
    )
    .output(staffMembershipChangeSchema),
  startSupportView: endpoint
    .route({
      method: 'POST',
      path: '/v1/staff/workspaces/{workspaceId}/users/{userId}/support-view',
      successStatus: 201,
      summary: 'Start a read-only support view as a member',
      description:
        'Opens the customer app as this member for up to thirty minutes. The view refuses every change and appears in the workspace’s Activity. `consent` needs `staff.view-as` and the workspace’s current consent. `emergency` needs `staff.view-as.emergency`, a category, a reference and recent staff authentication; owners are emailed when it ends. Starting a view ends this session’s other views. Requires a current workspace grant.',
    })
    .meta({ errors })
    .input(
      z.object({
        params: workspaceParams.extend({ userId: z.string().uuid() }),
        body: z.discriminatedUnion('mode', [
          z
            .object({
              mode: z.literal('consent'),
              grantId: z.string().uuid(),
              reason: staffReasonSchema,
            })
            .strict(),
          z
            .object({
              mode: z.literal('emergency'),
              grantId: z.string().uuid(),
              reason: staffReasonSchema,
              category: staffEmergencyCategorySchema,
              reference: z.string().trim().min(3).max(200),
            })
            .strict(),
        ]),
      }),
    )
    .output(staffSupportViewSchema),
  requestSupportAccess: endpoint
    .route({
      method: 'POST',
      path: '/v1/staff/workspaces/{workspaceId}/support-access-requests',
      successStatus: 201,
      summary: 'Ask a workspace to allow support access',
      description:
        'Asks the workspace’s owners and admins to allow read-only support views for 24, 72 or 168 hours. Owners are emailed; the reason is shown to them. One request can be pending; it lapses after seven days. Requires `staff.view-as` and a current workspace grant.',
    })
    .meta({ errors })
    .input(
      z.object({
        params: workspaceParams,
        body: z
          .object({
            grantId: z.string().uuid(),
            reason: staffReasonSchema,
            durationHours: z.union([
              z.literal(24),
              z.literal(72),
              z.literal(168),
            ]),
          })
          .strict(),
      }),
    )
    .output(staffSupportAccessRequestSchema),
  grantAccountAccess: endpoint
    .route({
      method: 'POST',
      path: '/v1/staff/accounts/{userId}/access',
      successStatus: 201,
      summary: 'Open time-limited account support access',
      description:
        'Opens thirty minutes of access to one customer account for the current staff session. Grants no workspace access.',
    })
    .meta({ errors })
    .input(
      z.object({
        params: accountParams,
        body: z.object({ reason: staffReasonSchema }).strict(),
      }),
    )
    .output(staffAccountAccessSchema),
  account: endpoint
    .route({
      method: 'GET',
      path: '/v1/staff/accounts/{userId}',
      summary: 'Inspect a customer account using a current account grant',
      description:
        'Returns profile, workspace memberships, sign-in factor status and active sessions. Lists are limited to 100 entries.',
    })
    .meta({ errors })
    .input(
      z.object({
        params: accountParams,
        query: z.object({ grantId: z.string().uuid() }),
      }),
    )
    .output(staffAccountDetailSchema),
  accountSecurityEvents: endpoint
    .route({
      method: 'GET',
      path: '/v1/staff/accounts/{userId}/security-events',
      summary: 'Page through a customer account’s security events',
      description:
        'Returns sign-ins, failed attempts and security changes, newest first, 25 per page, using a current account grant. IP addresses and user agents are cleared after 90 days; events are deleted after a year.',
    })
    .meta({ errors })
    .input(
      z.object({
        params: accountParams,
        query: z.object({
          grantId: z.string().uuid(),
          cursor: z.string().max(200).optional(),
        }),
      }),
    )
    .output(staffAccountSecurityEventsSchema),
  disableAccount: endpoint
    .route({
      method: 'POST',
      path: '/v1/staff/accounts/{userId}/disable',
      summary: 'Disable a customer account',
      description:
        'Ends every session of the account at once and refuses new sign-ins with a message that names no reason. Every workspace rejects the person and workflows acting as them pause; memberships are kept. Uses a current account grant. Requires `staff.accounts.manage`, recent staff authentication and acknowledgement of the effect on all workspaces. Repeated command IDs return the original receipt; reusing one for another request returns 409.',
    })
    .meta({ errors })
    .input(
      z.object({
        params: accountParams,
        body: z
          .object({
            grantId: z.string().uuid(),
            category: staffAccountDisableCategorySchema,
            reason: staffReasonSchema,
            commandId: z.string().uuid(),
            acknowledgeGlobalEffect: z.literal(true),
          })
          .strict(),
      }),
    )
    .output(staffAccountChangeSchema),
  enableAccount: endpoint
    .route({
      method: 'POST',
      path: '/v1/staff/accounts/{userId}/enable',
      summary: 'Enable a disabled customer account',
      description:
        'Allows sign-in again and restores access to every workspace the person belongs to, with their roles. Paused workflows acting as them continue. Uses a current account grant. Requires `staff.accounts.manage` and recent staff authentication. Repeated command IDs return the original receipt; reusing one for another request returns 409.',
    })
    .meta({ errors })
    .input(
      z.object({
        params: accountParams,
        body: z
          .object({
            grantId: z.string().uuid(),
            reason: staffReasonSchema,
            commandId: z.string().uuid(),
          })
          .strict(),
      }),
    )
    .output(staffAccountChangeSchema),
  scheduleAccountDeletion: endpoint
    .route({
      method: 'POST',
      path: '/v1/staff/accounts/{userId}/deletion',
      summary: 'Schedule a customer account for deletion',
      description:
        'Disables the account, ends its sessions and suspends its memberships now, and erases it permanently after 30 days unless it is restored. Refused with 409 while the person is the only owner of a workspace that isn’t closed. Uses a current account grant. Requires `staff.accounts.delete`, recent staff authentication, a category, the request reference and acknowledgement of the effect on all workspaces. The person is notified by email. Repeated command IDs return the original receipt; reusing one for another request returns 409.',
    })
    .meta({ errors })
    .input(
      z.object({
        params: accountParams,
        body: z
          .object({
            grantId: z.string().uuid(),
            category: staffAccountDeletionCategorySchema,
            reference: staffDeletionReferenceSchema,
            reason: staffReasonSchema,
            commandId: z.string().uuid(),
            acknowledgeGlobalEffect: z.literal(true),
          })
          .strict(),
      }),
    )
    .output(staffAccountDeletionChangeSchema),
  restoreAccount: endpoint
    .route({
      method: 'POST',
      path: '/v1/staff/accounts/{userId}/restore',
      summary: 'Restore an account scheduled for deletion',
      description:
        'Cancels the scheduled deletion: the memberships it suspended become active again with their roles, and the account is enabled unless it was disabled before. Ended sessions stay ended. Refused with 409 when no deletion is scheduled or erasure was already requested. Uses a current account grant. Requires `staff.accounts.delete` and recent staff authentication. The person is notified by email. Repeated command IDs return the original receipt.',
    })
    .meta({ errors })
    .input(
      z.object({
        params: accountParams,
        body: z
          .object({
            grantId: z.string().uuid(),
            reason: staffReasonSchema,
            commandId: z.string().uuid(),
          })
          .strict(),
      }),
    )
    .output(staffAccountDeletionChangeSchema),
  eraseAccountNow: endpoint
    .route({
      method: 'POST',
      path: '/v1/staff/accounts/{userId}/erasure',
      summary: 'Erase a customer account now',
      description:
        'For a verified erasure request under GDPR Art. 17: skips the 30-day restore window and erases the account within minutes. It can’t be restored. Schedules the deletion first when none is scheduled, with the same owner check. Uses a current account grant. Requires `staff.accounts.delete`, recent staff authentication, the request reference and acknowledgement that erasure is permanent. Repeated command IDs return the original receipt.',
    })
    .meta({ errors })
    .input(
      z.object({
        params: accountParams,
        body: z
          .object({
            grantId: z.string().uuid(),
            reference: staffDeletionReferenceSchema,
            reason: staffReasonSchema,
            commandId: z.string().uuid(),
            acknowledgePermanent: z.literal(true),
          })
          .strict(),
      }),
    )
    .output(staffAccountDeletionChangeSchema),
};
