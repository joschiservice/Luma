import { z } from 'zod';

import {
  anyMember,
  endpoint,
  organizationParamsSchema,
  requires,
} from '../common.js';
import { saveWorkspaceLayoutSchema, workspaceLayoutSchema } from '../layout.js';
import { invitationSchema, settingsSnapshotSchema } from '../settings.js';

const path = '/v1/organizations/{organizationId}/settings';
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

export const settingsContract = {
  receipt: endpoint
    .route({
      method: 'GET',
      path: `${path}/commands/{commandId}`,
      summary: 'Check whether your settings command committed',
    })
    .meta({ access: anyMember, errors: [401, 403, 404, 409, 503] })
    .input(
      z.object({
        params: organizationParamsSchema.extend({
          commandId: z.string().uuid(),
        }),
      }),
    )
    .output(z.object({ committed: z.boolean() })),
  get: endpoint
    .route({
      method: 'GET',
      path,
      summary: 'Read workspace settings and your email preferences',
    })
    .meta({ access: anyMember, errors: [401, 403, 404, 409, 503] })
    .input(z.object({ params: organizationParamsSchema }))
    .output(settingsSnapshotSchema),
  updateWorkspace: endpoint
    .route({
      method: 'PATCH',
      path: `${path}/workspace`,
      summary: 'Update the workspace name and display timezone',
    })
    .meta({
      access: requires('workspace.settings.manage'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(
      z.object({
        params: organizationParamsSchema,
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
      }),
    )
    .output(settingsSnapshotSchema),
  updateApprovals: endpoint
    .route({
      method: 'PATCH',
      path: `${path}/approvals`,
      summary: 'Require independent approval for otherwise permitted changes',
      description:
        'Requires `workspace.approval_policy.manage`. This preference can only strengthen approval requirements. Platform denials and required approvals always apply. Changing this preference invalidates previous policy reviews.',
    })
    .meta({
      access: requires('workspace.approval_policy.manage'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(
      z.object({
        params: organizationParamsSchema,
        body: command
          .extend({
            revision: z.number().int().nonnegative(),
            alwaysRequireApproval: z.boolean(),
          })
          .strict(),
      }),
    )
    .output(settingsSnapshotSchema),
  updateNotifications: endpoint
    .route({
      method: 'PATCH',
      path: `${path}/notifications`,
      summary: 'Save your workspace email preferences',
    })
    .meta({ access: anyMember, errors: [401, 403, 404, 409, 503] })
    .input(
      z.object({
        params: organizationParamsSchema,
        body: command
          .extend({
            revision: z.number().int().nonnegative(),
            issues: z.boolean(),
            connections: z.boolean(),
          })
          .strict(),
      }),
    )
    .output(settingsSnapshotSchema),
  layout: endpoint
    .route({
      method: 'GET',
      path: `${path}/layout`,
      summary: 'Read your Home layout and pinned pages',
      description:
        'Layouts are personal: each member arranges their own Home and sidebar pins in each workspace. A null Home uses the default modules.',
    })
    .meta({ access: anyMember, errors: [401, 403, 404, 409, 503] })
    .input(z.object({ params: organizationParamsSchema }))
    .output(workspaceLayoutSchema),
  saveLayout: endpoint
    .route({
      method: 'PUT',
      path: `${path}/layout`,
      summary: 'Save your Home layout and pinned pages',
      description:
        'Send the revision you last read. The save is rejected with 409 when another session saved a newer layout; read it again before retrying.',
    })
    .meta({ access: anyMember, errors: [401, 403, 404, 409, 503] })
    .input(
      z.object({
        params: organizationParamsSchema,
        body: saveWorkspaceLayoutSchema,
      }),
    )
    .output(workspaceLayoutSchema),
  testEmail: endpoint
    .route({
      method: 'POST',
      path: `${path}/notifications/test`,
      summary: 'Queue a test email to your account',
    })
    .meta({ access: anyMember, errors: [401, 403, 404, 409, 503] })
    .input(
      z.object({ params: organizationParamsSchema, body: command.strict() }),
    )
    .output(settingsSnapshotSchema),
  invitations: endpoint
    .route({
      method: 'GET',
      path: `${path}/invitations`,
      summary: 'List workspace invitations',
    })
    .meta({
      access: requires('members.manage'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: organizationParamsSchema }))
    .output(z.object({ items: z.array(invitationSchema) })),
  invite: endpoint
    .route({
      method: 'POST',
      path: `${path}/invitations`,
      summary: 'Invite a teammate by email',
      description:
        'Sending an invitation does not grant access. The invitation is bound to an active role other than Owner whose permissions you hold. An existing pending invitation must be resent or revoked; existing members cannot be invited.',
    })
    .meta({
      access: requires('members.manage'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(
      z.object({
        params: organizationParamsSchema,
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
      }),
    )
    .output(invitationSchema),
  changeInvitation: endpoint
    .route({
      method: 'POST',
      path: `${path}/invitations/{invitationId}`,
      summary: 'Resend or revoke an invitation',
      description:
        'Resending replaces the previous link and starts a new seven-day expiry.',
    })
    .meta({
      access: requires('members.manage'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(
      z.object({
        params: invitationParams,
        body: command
          .extend({
            action: z.enum(['resend', 'revoke']),
            generation: z.number().int().positive(),
          })
          .strict(),
      }),
    )
    .output(invitationSchema),
  previewInvitation: endpoint
    .route({
      method: 'POST',
      path: '/v1/invitations/preview',
      summary: 'Review an invitation for your signed-in email',
    })
    .meta({ errors: [401, 403, 404, 409, 503] })
    .input(z.object({ body: invitationProof }))
    .output(
      z.object({
        name: z.string(),
        email: z.string(),
        role: z.object({ id: z.string(), name: z.string() }),
        expiresAt: z.string(),
      }),
    ),
  acceptInvitation: endpoint
    .route({
      method: 'POST',
      path: '/v1/invitations/accept',
      summary: 'Accept a single-use invitation for your signed-in email',
    })
    .meta({ errors: [401, 403, 404, 409, 503] })
    .input(z.object({ body: invitationProof }))
    .output(z.object({ organizationId: z.string().uuid() })),
};
