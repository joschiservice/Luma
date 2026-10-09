import { z } from 'zod';

import { endpoint, type ErrorStatus } from './common.js';

export const staffPermissionSchema = z.enum([
  'staff.directory.read',
  'staff.workspace.inspect',
  'staff.sessions.revoke',
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
