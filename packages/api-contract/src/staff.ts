import { z } from 'zod';

import { endpoint, type ErrorStatus } from './common.js';

export const staffPermissionSchema = z.enum([
  'staff.directory.read',
  'staff.workspace.inspect',
  'staff.sessions.revoke',
  'staff.audit.read',
]);

export const staffWorkspaceSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  status: z.string(),
  dataRegion: z.string(),
});

export const staffUserSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  email: z.string(),
});

export const staffAccessSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  reason: z.string(),
  expiresAt: z.string().datetime(),
});

export const staffDetailSchema = z.object({
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
});

export const staffReasonSchema = z.string().trim().min(10).max(500);

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
export const staffAccessHistoryCursorSchema = z
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
export const staffAuditCursorSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z_\d{1,19}$/);

/** Optional audit filters. Staff member and account accept an ID or an exact email address. */
export const staffAuditQuerySchema = z
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

const workspaceParams = z.object({ workspaceId: z.string().uuid() });
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
};
