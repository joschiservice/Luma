import { z } from 'zod';

export const activityOutcomes = [
  'approved',
  'rejected',
  'escalated',
  'attempted',
  'provider_accepted',
  'verified',
  'failed',
  'uncertain',
  'manually_disposed',
  'recorded',
] as const;

export const activityTypes = [
  'issue',
  'decision',
  'execution',
  'verification',
  'resolution',
  'connection',
  'procurement',
  'access',
] as const;

export const activityQuerySchema = z
  .object({
    from: z.string().datetime(),
    to: z.string().datetime(),
    q: z.string().trim().max(200).optional(),
    system: z.string().min(1).max(100).optional(),
    connectionId: z.string().uuid().optional(),
    type: z.enum(activityTypes).optional(),
    outcome: z.enum(activityOutcomes).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
    cursor: z.string().max(2048).optional(),
  })
  .refine(
    (v) =>
      Date.parse(v.from) < Date.parse(v.to) &&
      Date.parse(v.to) - Date.parse(v.from) <= 366 * 86400000,
    { message: 'Select a date range of at most 366 days' },
  );

export const activityActorKinds = [
  'member',
  'former_member',
  'luma',
  'support',
  'service',
  'unrecorded',
] as const;

/**
 * Who recorded an event. Former members keep the name recorded when they left, which may be
 * missing. Email is present only for current members. Luma records detection and verification
 * itself; `support` is Luma staff acting on the workspace, without a personal ID. `workflow` names the workflow whose run acted on the person's behalf.
 */
export const activityActorSchema = z.object({
  kind: z.enum(activityActorKinds),
  id: z.string().max(300).nullable(),
  name: z.string().max(200).nullable(),
  email: z.string().max(320).nullable(),
  workflow: z
    .object({ id: z.string().max(200), name: z.string().max(200).nullable() })
    .nullable(),
});

export const activityEventSchema = z.object({
  id: z.string().max(200),
  recordedAt: z.string().datetime(),
  occurredAt: z.string().datetime().nullable(),
  actor: activityActorSchema,
  action: z.string().max(160),
  type: z.enum(activityTypes),
  outcome: z.enum(activityOutcomes),
  exceptionId: z.string().uuid().nullable(),
  proposalId: z.string().uuid().nullable(),
  attemptId: z.string().uuid().nullable(),
  connectionId: z.string().uuid().nullable(),
  system: z.string().max(100).nullable(),
  resource: z.string().max(300).nullable(),
  playbookId: z.string().max(200).nullable(),
  mode: z.enum(['simulation', 'shadow', 'pilot', 'unrecorded']),
  summary: z.string().max(300).nullable(),
  executionState: z.string().max(100).nullable(),
  verificationPhase: z.string().max(40).nullable(),
  failureCode: z.string().max(100).nullable(),
  connections: z
    .array(
      z.object({
        id: z.string().uuid(),
        system: z.string().max(100).nullable(),
      }),
    )
    .max(100),
  dispatch: z.string().max(100).nullable(),
  verification: z.string().max(100).nullable(),
  evidenceRefs: z.array(z.string().max(500)).max(100),
});

export const activityPageSchema = z.object({
  visibility: z.enum(['member', 'admin']),
  items: z.array(activityEventSchema).max(100),
  nextCursor: z.string().nullable(),
  coverage: z.string(),
});

export type ActivityQuery = z.infer<typeof activityQuerySchema>;

export type ActivityActor = z.infer<typeof activityActorSchema>;

export type ActivityEvent = z.infer<typeof activityEventSchema>;

export type ActivityPage = z.infer<typeof activityPageSchema>;
