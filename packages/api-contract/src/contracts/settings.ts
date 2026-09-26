import { initContract } from '@ts-rest/core';
import { z } from 'zod';

import { apiErrorSchema, organizationParamsSchema } from '../common.js';
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
      path: `${path}/commands/:commandId`,
      pathParams: organizationParamsSchema.extend({
        commandId: z.string().uuid(),
      }),
      responses: { 200: z.object({ committed: z.boolean() }) },
      summary: 'Check whether your settings command committed',
    },
    get: {
      method: 'GET',
      path,
      pathParams: organizationParamsSchema,
      responses: { 200: settingsSnapshotSchema },
      summary: 'Read workspace settings and your email preferences',
    },
    updateWorkspace: {
      method: 'PATCH',
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
        'Owners and admins may strengthen approval requirements. Platform denials and required approvals always apply. Changing this preference invalidates previous policy reviews.',
    },
    updateNotifications: {
      method: 'PATCH',
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
    testEmail: {
      method: 'POST',
      path: `${path}/notifications/test`,
      pathParams: organizationParamsSchema,
      body: command.strict(),
      responses: { 200: settingsSnapshotSchema },
      summary: 'Queue a test email to your account',
    },
    invitations: {
      method: 'GET',
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
          role: z.enum(['admin', 'member']),
        })
        .strict(),
      responses: { 200: invitationSchema },
      summary: 'Invite a teammate by email',
      description:
        'Sending an invitation does not grant access. An existing pending invitation must be resent or revoked; existing members cannot be invited.',
    },
    changeInvitation: {
      method: 'POST',
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
          role: z.enum(['admin', 'member']),
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
