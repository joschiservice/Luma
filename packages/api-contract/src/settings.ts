import { z } from 'zod';

import { roleReferenceSchema } from './roles.js';

const workspaceSettingsSchema = z.object({
  name: z.string(),
  slug: z.string(),
  dataRegion: z.string(),
  timezone: z.string(),
  revision: z.number().int(),
  alwaysRequireApproval: z.boolean(),
  /** Team preference; ignored while fewer than two members have access. */
  requireIndependentApproval: z.boolean(),
  activeMemberCount: z.number().int().nonnegative(),
  policyRevision: z.number().int(),
  writeMode: z.enum(['observe_only', 'writes_enabled']),
});

const notificationPreferencesSchema = z.object({
  issues: z.boolean(),
  connections: z.boolean(),
  revision: z.number().int(),
});

const deliveryStateSchema = z.enum(['queued', 'sent', 'failed', 'cancelled']);

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
  /**
   * Why Luma paused optional email to your address: it bounced permanently or you reported
   * Luma's email as spam. Null when email to you is not paused. A delivered test email resumes it.
   */
  emailPaused: z.enum(['bounced', 'complained']).nullable(),
  lastTest: z
    .object({ id: z.string().uuid(), state: deliveryStateSchema })
    .nullable(),
});

/** How long a workspace allows Luma support access: 24 hours, 3 days or 7 days. */
export const supportAccessDurationSchema = z.union([
  z.literal(24),
  z.literal(72),
  z.literal(168),
]);

const supportAccessRequestSchema = z.object({
  id: z.string().uuid(),
  /** Why Luma support asks for access, written by the support team. */
  reason: z.string(),
  durationHours: supportAccessDurationSchema,
  requestedAt: z.string().datetime(),
  /** The request lapses unanswered after this time. */
  expiresAt: z.string().datetime(),
});

export const supportAccessSchema = z.object({
  /** When Luma support access ends; null when it isn't allowed. */
  allowedUntil: z.string().datetime().nullable(),
  /** When access was last allowed or revoked; null when it never was. */
  changedAt: z.string().datetime().nullable(),
  revision: z.number().int().nonnegative(),
  /** Pending requests from Luma support; at most one. */
  requests: z.array(supportAccessRequestSchema),
});

export type SupportAccess = z.infer<typeof supportAccessSchema>;

export type SettingsSnapshot = z.infer<typeof settingsSnapshotSchema>;
