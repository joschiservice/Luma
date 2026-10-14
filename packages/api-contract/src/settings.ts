import { z } from 'zod';

import { roleReferenceSchema } from './roles.js';

/** Workspace detection windows; oversell risk has a shorter independent confirmation window. */
export const detectionSettingsSchema = z
  .object({
    inventoryTolerance: z.string().regex(/^\d{1,14}(?:\.\d{1,6})?$/),
    propagationSeconds: z.number().int().min(0).max(86400),
    oversellPropagationSeconds: z.number().int().min(0).max(3600),
    stuckSeconds: z.number().int().min(60).max(604800),
  })
  .strict();

/** Additional supplier-send review for replenishment orders; unknown values require review when a threshold is set. */
export const replenishmentApprovalSchema = z
  .object({
    separateSend: z.boolean(),
    threshold: z
      .object({
        amount: z.string().regex(/^\d{1,14}(?:\.\d{1,6})?$/),
        currency: z.string().regex(/^[A-Z]{3}$/),
      })
      .nullable(),
  })
  .strict();

const workspaceSettingsSchema = z.object({
  name: z.string(),
  slug: z.string(),
  dataRegion: z.string(),
  timezone: z.string(),
  detection: detectionSettingsSchema.optional(),
  revision: z.number().int(),
  alwaysRequireApproval: z.boolean(),
  /** Team preference; ignored while fewer than two members have access. */
  requireIndependentApproval: z.boolean(),
  activeMemberCount: z.number().int().nonnegative(),
  policyRevision: z.number().int(),
  replenishmentApproval: replenishmentApprovalSchema.optional(),
  writeMode: z.enum(['observe_only', 'writes_enabled']),
});

const notificationPreferencesSchema = z.object({
  issues: z.boolean(),
  connections: z.boolean(),
  morningBrief: z.boolean(),
  morningBriefTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
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
  morningBriefAvailable: z.boolean().optional(),
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
