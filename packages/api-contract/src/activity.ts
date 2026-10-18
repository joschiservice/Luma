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
  'privacy',
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

/** The `outcome` parameter: comma-separated outcomes, matching any. */
const activityOutcomeParameter = z
  .string()
  .max(400)
  .transform((text) => text.split(','))
  .pipe(z.array(z.enum(activityOutcomes)).min(1).max(activityOutcomes.length))
  .describe(
    `Comma-separated outcomes, matching any, such as \`failed,uncertain,escalated\`. Outcomes: ${activityOutcomes.map((outcome) => `\`${outcome}\``).join(', ')}.`,
  );

/** Issue classes whose names match the search in the reader's language, comma-separated. */
const activitySearchIssueClassesParameter = z
  .string()
  .max(800)
  .transform((text) => text.split(','))
  .pipe(
    z
      .array(
        z
          .string()
          .regex(/^[a-z][a-z0-9_]*$/)
          .max(100),
      )
      .min(1)
      .max(20),
  )
  .describe(
    'Comma-separated issue classes, such as `stuck_fulfillment`, whose names match `q` in the reader’s language. Events of these classes match the search too, so clients can search by translated issue names.',
  );

/** The filters every activity read shares. */
const activityFilters = {
  from: z.string().datetime(),
  to: z.string().datetime(),
  q: z.string().trim().max(200).optional(),
  searchIssueClasses: activitySearchIssueClassesParameter.optional(),
  system: z.string().min(1).max(100).optional(),
  connectionId: z.string().uuid().optional(),
  type: z.enum(activityTypes).optional(),
  outcome: activityOutcomeParameter.optional(),
  actor: activityActorParameter.optional(),
};

const withinRange = (v: { from: string; to: string }) =>
  Date.parse(v.from) < Date.parse(v.to) &&
  Date.parse(v.to) - Date.parse(v.from) <= 366 * 86400000;
const rangeMessage = { message: 'Select a date range of at most 366 days' };

export const activityQuerySchema = z
  .object({
    view: z.enum(['events', 'business']).default('events'),
    detail: z.enum(['summary', 'steps']).default('summary'),
    ...activityFilters,
    event: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        'Returns only the group, or in the event view the event, with this event ID, under the same filters. The group may hold the event as an earlier step. Takes no cursor.',
      ),
    limit: z.coerce.number().int().min(1).max(100).default(30),
    cursor: z.string().max(2048).optional(),
  })
  .refine(withinRange, rangeMessage)
  .refine((v) => !(v.event && v.cursor), {
    message: 'Read an event without a page cursor',
  });

/** Counting takes the list filters except the outcome, which the counts break down. */
export const activityCountsQuerySchema = z
  .object(activityFilters)
  .omit({ outcome: true })
  .refine(withinRange, rangeMessage);

/** Counts of business groups by outcome under the filters. */
export const activityCountsSchema = z.object({
  total: z.number().int().nonnegative(),
  /** Groups with a failed, unclear or escalated event. */
  attention: z.number().int().nonnegative(),
  outcomes: z.partialRecord(
    z.enum(activityOutcomes),
    z.number().int().nonnegative(),
  ),
});

/** Columns an activity export writes, in order. */
const activityExportColumns = [
  'recordedAt',
  'occurredAt',
  'action',
  'type',
  'outcome',
  'actorKind',
  'actor',
  'actorEmail',
  'workflow',
  'issueClass',
  'resourceKind',
  'resource',
  'summary',
  'system',
  'connections',
  'dispatch',
  'executionState',
  'verificationPhase',
  'verification',
  'failureCode',
  'mode',
  'eventId',
  'issueId',
  'proposalId',
  'attemptId',
  'workflowRunId',
  'evidence',
] as const;

export const activityExportRequestSchema = z
  .object({
    query: z.object(activityFilters).strict().refine(withinRange, rangeMessage),
    /** Column headings in the reader's language, keyed by column. */
    headings: z.partialRecord(
      z.enum(activityExportColumns),
      z.string().max(200),
    ),
    /**
     * Readable names for recorded codes, keyed `column:code`, such as
     * `outcome:verified`. Codes without a name are written as recorded.
     */
    values: z
      .record(z.string().max(220), z.string().max(200))
      .refine((values) => Object.keys(values).length <= 1000, {
        message: 'Send at most 1,000 value names',
      }),
    /** The last line of a file that was cut off. */
    truncated: z.string().max(300),
  })
  .strict();

export const activityExportSchema = z.object({
  filename: z.string(),
  csv: z.string(),
  rows: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

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
  /** The kind of issue the event concerns, such as `stuck_fulfillment`. */
  issueClass: z.string().max(100).nullable().optional(),
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

export type ActivityCounts = z.infer<typeof activityCountsSchema>;

export type ActivityExportRequest = z.input<typeof activityExportRequestSchema>;
