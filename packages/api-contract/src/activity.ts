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

/**
 * Actor filter values besides user IDs: `me` is the reader, `luma` is Luma itself and Luma
 * support, `workflow` is any event a workflow run recorded.
 */
const activityActorFilters = ['me', 'luma', 'workflow'] as const;

const activityActorValue = z.union([
  z.enum(activityActorFilters),
  z
    .string()
    .regex(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      'Expected me, luma, workflow or a user ID',
    )
    .transform((id) => id.toLowerCase()),
]);

/** The `actor` parameter: comma-separated actor filter values, at most 20. */
const activityActorParameter = z
  .string()
  .max(800)
  .transform((text) => text.split(','))
  .pipe(z.array(activityActorValue).min(1).max(20))
  .describe(
    'Comma-separated actors, matching any: `me` (the reader), `luma` (Luma and Luma support), `workflow` (events a workflow run recorded) or user IDs. A person also matches workflow runs that act for them.',
  );

export const activityQuerySchema = z
  .object({
    view: z.enum(['events', 'business']).default('events'),
    detail: z.enum(['summary', 'steps']).default('summary'),
    from: z.string().datetime(),
    to: z.string().datetime(),
    q: z.string().trim().max(200).optional(),
    system: z.string().min(1).max(100).optional(),
    connectionId: z.string().uuid().optional(),
    type: z.enum(activityTypes).optional(),
    outcome: z.enum(activityOutcomes).optional(),
    actor: activityActorParameter.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
    cursor: z.string().max(2048).optional(),
  })
  .refine(
    (v) =>
      Date.parse(v.from) < Date.parse(v.to) &&
      Date.parse(v.to) - Date.parse(v.from) <= 366 * 86400000,
    { message: 'Select a date range of at most 366 days' },
  );

const activityActorKinds = [
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

const activityEventSchema = z.object({
  workflowRunId: z.string().uuid().nullable().optional(),
  resourceKind: z.string().nullable().optional(),
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
  items: z
    .array(
      activityEventSchema.extend({
        steps: z.array(activityEventSchema).max(100).optional(),
      }),
    )
    .max(100),
  nextCursor: z.string().nullable(),
  coverage: z.string(),
});

export type ActivityQuery = z.infer<typeof activityQuerySchema>;

export type ActivityActor = z.infer<typeof activityActorSchema>;

export type ActivityEvent = z.infer<typeof activityPageSchema>['items'][number];

export type ActivityPage = z.infer<typeof activityPageSchema>;
