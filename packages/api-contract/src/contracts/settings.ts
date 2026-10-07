import { initContract } from '@ts-rest/core';
import { z } from 'zod';

import {
  anyMember,
  apiErrorSchema,
  organizationParamsSchema,
  requires,
} from '../common.js';
import { saveWorkspaceLayoutSchema, workspaceLayoutSchema } from '../layout.js';
import { invitationSchema, settingsSnapshotSchema } from '../settings.js';

const c = initContract();
const path = '/v1/organizations/:organizationId/settings';
const command = z.object({ commandId: z.string().uuid() });
const invitationParams = organizationParamsSchema.extend({
  invitationId: z.string().uuid(),
});
const invitationProof = z
  .object({
    organizationId: z.string().uuid(),
    invitationId: z.string().uuid(),
    token: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const settingsContract = c.router(
  {
    receipt: {
      method: 'GET',
      metadata: anyMember,
      path: `${path}/commands/:commandId`,
      pathParams: organizationParamsSchema.extend({
        commandId: z.string().uuid(),
      }),
      responses: { 200: z.object({ committed: z.boolean() }) },
      summary: 'Check whether your settings command committed',
    },
    get: {
      method: 'GET',
      metadata: anyMember,
      path,
      pathParams: organizationParamsSchema,
      responses: { 200: settingsSnapshotSchema },
      summary: 'Read workspace settings and your email preferences',
    },
    updateWorkspace: {
      method: 'PATCH',
      metadata: requires('workspace.settings.manage'),
      path: `${path}/workspace`,
      pathParams: organizationParamsSchema,
      body: command
        .extend({
          revision: z.number().int().nonnegative(),
          name: z.string().trim().min(1).max(200),
          timezone: z
            .string()
            .min(1)
            .max(100)
            .refine((value) => {
              try {
                new Intl.DateTimeFormat('en', { timeZone: value });

                return true;
              } catch {
                return false;
              }
            }),
        })
        .strict(),
      responses: { 200: settingsSnapshotSchema },
      summary: 'Update the workspace name and display timezone',
    },
    updateApprovals: {
      method: 'PATCH',
      metadata: requires('workspace.approval_policy.manage'),
      path: `${path}/approvals`,
      pathParams: organizationParamsSchema,
      body: command
        .extend({
          revision: z.number().int().nonnegative(),
          alwaysRequireApproval: z.boolean(),
        })
        .strict(),
      responses: { 200: settingsSnapshotSchema },
      summary: 'Require independent approval for otherwise permitted changes',
      description:
        'Requires `workspace.approval_policy.manage`. This preference can only strengthen approval requirements. Platform denials and required approvals always apply. Changing this preference invalidates previous policy reviews.',
    },
    updateNotifications: {
      method: 'PATCH',
      metadata: anyMember,
      path: `${path}/notifications`,
      pathParams: organizationParamsSchema,
      body: command
        .extend({
          revision: z.number().int().nonnegative(),
          issues: z.boolean(),
          connections: z.boolean(),
        })
        .strict(),
      responses: { 200: settingsSnapshotSchema },
      summary: 'Save your workspace email preferences',
    },
    layout: {
      method: 'GET',
      metadata: anyMember,
      path: `${path}/layout`,
      pathParams: organizationParamsSchema,
      responses: { 200: workspaceLayoutSchema },
      summary: 'Read your Home layout and pinned pages',
      description:
        'Layouts are personal: each member arranges their own Home and sidebar pins in each workspace. A null Home uses the default modules.',
    },
    saveLayout: {
      method: 'PUT',
      metadata: anyMember,
      path: `${path}/layout`,
      pathParams: organizationParamsSchema,
      body: saveWorkspaceLayoutSchema,
      responses: { 200: workspaceLayoutSchema },
      summary: 'Save your Home layout and pinned pages',
      description:
        'Send the revision you last read. The save is rejected with 409 when another session saved a newer layout; read it again before retrying.',
    },
    testEmail: {
      method: 'POST',
      metadata: anyMember,
      path: `${path}/notifications/test`,
      pathParams: organizationParamsSchema,
      body: command.strict(),
      responses: { 200: settingsSnapshotSchema },
      summary: 'Queue a test email to your account',
    },
    invitations: {
      method: 'GET',
      metadata: requires('members.manage'),
      path: `${path}/invitations`,
      pathParams: organizationParamsSchema,
      responses: { 200: z.object({ items: z.array(invitationSchema) }) },
      summary: 'List workspace invitations',
    },
    invite: {
      method: 'POST',
      path: `${path}/invitations`,
      pathParams: organizationParamsSchema,
      body: command
        .extend({
          email: z
            .string()
            .trim()
            .email()
            .max(254)
            .transform((value) => value.toLowerCase()),
          roleId: z.string().min(1),
        })
        .strict(),
      responses: { 200: invitationSchema },
      metadata: requires('members.manage'),
      summary: 'Invite a teammate by email',
      description:
        'Sending an invitation does not grant access. The invitation is bound to an active role other than Owner whose permissions you hold. An existing pending invitation must be resent or revoked; existing members cannot be invited.',
    },
    changeInvitation: {
      method: 'POST',
      metadata: requires('members.manage'),
      path: `${path}/invitations/:invitationId`,
      pathParams: invitationParams,
      body: command
        .extend({
          action: z.enum(['resend', 'revoke']),
          generation: z.number().int().positive(),
        })
        .strict(),
      responses: { 200: invitationSchema },
      summary: 'Resend or revoke an invitation',
      description:
        'Resending replaces the previous link and starts a new seven-day expiry.',
    },
    previewInvitation: {
      method: 'POST',
      path: '/v1/invitations/preview',
      body: invitationProof,
      responses: {
        200: z.object({
          name: z.string(),
          email: z.string(),
          role: z.object({ id: z.string(), name: z.string() }),
          expiresAt: z.string(),
        }),
      },
      summary: 'Review an invitation for your signed-in email',
    },
    acceptInvitation: {
      method: 'POST',
      path: '/v1/invitations/accept',
      body: invitationProof,
      responses: { 200: z.object({ organizationId: z.string().uuid() }) },
      summary: 'Accept a single-use invitation for your signed-in email',
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
