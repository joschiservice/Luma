import { initContract } from '@ts-rest/core';
import { z } from 'zod';

import { apiErrorSchema } from './common.js';

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
const c = initContract();

/** Dedicated staff API contract; customer routes do not include these capabilities. */
export const staffContract = c.router(
  {
    config: {
      method: 'GET',
      path: '/v1/staff/config',
      responses: { 200: staffConfigSchema },
      summary: 'Get the staff sign-in method',
    },
    session: {
      method: 'GET',
      path: '/v1/staff/session',
      responses: { 200: staffSessionSchema },
      summary: 'Resolve current staff access',
    },
    directory: {
      method: 'GET',
      path: '/v1/staff/directory',
      query: z.object({ query: z.string().trim().min(3).max(100) }),
      responses: { 200: staffDirectorySchema },
      summary: 'Search the support directory',
    },
    grantAccess: {
      method: 'POST',
      path: '/v1/staff/workspaces/:workspaceId/access',
      pathParams: workspaceParams,
      body: z.object({ reason: staffReasonSchema }).strict(),
      responses: { 201: staffAccessSchema },
      summary: 'Open time-limited workspace support access',
    },
    workspace: {
      method: 'GET',
      path: '/v1/staff/workspaces/:workspaceId',
      pathParams: workspaceParams,
      query: z.object({ grantId: z.string().uuid() }),
      responses: { 200: staffDetailSchema },
      summary: 'Inspect a workspace using a current support grant',
    },
    revokeSessions: {
      method: 'POST',
      path: '/v1/staff/workspaces/:workspaceId/users/:userId/revoke-sessions',
      pathParams: workspaceParams.extend({ userId: z.string().uuid() }),
      body: z
        .object({
          grantId: z.string().uuid(),
          reason: staffReasonSchema,
          commandId: z.string().uuid(),
          acknowledgeGlobalEffect: z.literal(true),
        })
        .strict(),
      responses: { 200: staffRevokeSessionsResultSchema },
      summary: 'Revoke all customer sessions',
      description:
        'Revokes sessions across every workspace belonging to the user. Requires recent staff authentication and explicit acknowledgement. Repeated command IDs return the original receipt.',
    },
  },
  {
    commonResponses: {
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      503: apiErrorSchema,
    },
  },
);
