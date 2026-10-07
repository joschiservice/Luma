import { z } from 'zod';

import { roleReferenceSchema } from './roles.js';

export const workspaceSettingsSchema = z.object({
  name: z.string(),
  slug: z.string(),
  dataRegion: z.string(),
  timezone: z.string(),
  revision: z.number().int(),
  alwaysRequireApproval: z.boolean(),
  policyRevision: z.number().int(),
});

export const notificationPreferencesSchema = z.object({
  issues: z.boolean(),
  connections: z.boolean(),
  revision: z.number().int(),
});

export const deliveryStateSchema = z.enum([
  'queued',
  'sent',
  'failed',
  'cancelled',
]);

export const invitationSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  role: roleReferenceSchema.extend({ archived: z.boolean() }),
  status: z.enum(['pending', 'expired', 'accepted', 'revoked']),
  expiresAt: z.string(),
  createdAt: z.string(),
  delivery: deliveryStateSchema,
  generation: z.number().int(),
});

export const settingsSnapshotSchema = z.object({
  workspace: workspaceSettingsSchema,
  preferences: notificationPreferencesSchema,
  deliveryAvailable: z.boolean(),
  lastTest: z
    .object({ id: z.string().uuid(), state: deliveryStateSchema })
    .nullable(),
});

export type WorkspaceSettings = z.infer<typeof workspaceSettingsSchema>;

export type NotificationPreferences = z.infer<
  typeof notificationPreferencesSchema
>;

export type WorkspaceInvitation = z.infer<typeof invitationSchema>;

export type SettingsSnapshot = z.infer<typeof settingsSnapshotSchema>;
