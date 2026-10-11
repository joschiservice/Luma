import { z } from 'zod';

const timestamp = z.string().datetime({ offset: true });

/** Records the assistant can read and cite. Each has a detail page in the workspace. */
const assistantRecordKindSchema = z.enum([
  'order',
  'issue',
  'stock_position',
  'fulfillment',
  'return',
]);

/** Whether the assistant can answer here, the reason when it can't, and what it can read. */
export const assistantAvailabilitySchema = z.object({
  available: z.boolean(),
  reason: z.string().nullable(),
  reads: z.array(assistantRecordKindSchema),
});

/** An earlier turn of the conversation, as the client shows it. Luma doesn't store conversations. */
const assistantTurnSchema = z
  .object({
    role: z.enum(['user', 'assistant']),
    content: z.string().min(1).max(8000),
  })
  .strict();

export const askAssistantSchema = z
  .object({
    question: z.string().trim().min(1).max(2000).regex(/\S/),
    /** Earlier turns, oldest first. Answers still read records again; history is not evidence. */
    history: z.array(assistantTurnSchema).max(20).default([]),
    /** IANA time zone used to interpret dates such as "last week". Defaults to UTC. */
    timeZone: z.string().min(1).max(64).optional(),
  })
  .strict();

/** A record an answer refers to, with the source and observation time of the data read. */
const assistantCitationSchema = z.object({
  kind: assistantRecordKindSchema,
  id: z.string().uuid(),
  label: z.string(),
  detail: z.string().nullable(),
  sources: z.array(
    z.object({ label: z.string(), system: z.string().nullable() }),
  ),
  /** When Luma last read this record from its source, or the issue's last activity. */
  observedAt: timestamp.nullable(),
  /** When the source last changed the record, if the source reports it. */
  sourceUpdatedAt: timestamp.nullable(),
});

/** One read the assistant made while answering. */
const assistantStepSchema = z.object({
  tool: z.string(),
  summary: z.string(),
  outcome: z.enum([
    'ok',
    'invalid_arguments',
    'not_found',
    'failed',
    'skipped',
  ]),
  records: z.number().int().nonnegative(),
});

export const assistantAnswerSchema = z.object({
  id: z.string().uuid(),
  /**
   * Plain text with light Markdown (paragraphs, lists, bold, inline code). Citation markers
   * have the form `[[kind:id]]` and each one matches an entry in `citations`.
   */
  content: z.string(),
  citations: z.array(assistantCitationSchema),
  steps: z.array(assistantStepSchema),
  /** `incomplete` when the answer hit a lookup or length limit before finishing. */
  outcome: z.enum(['answered', 'incomplete']),
  asOf: timestamp,
  usage: z.object({
    modelCalls: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  }),
});

export type AssistantRecordKind = z.infer<typeof assistantRecordKindSchema>;

export type AssistantTurn = z.infer<typeof assistantTurnSchema>;

export type AskAssistant = z.input<typeof askAssistantSchema>;

export type AssistantCitation = z.infer<typeof assistantCitationSchema>;

export type AssistantStep = z.infer<typeof assistantStepSchema>;

export type AssistantAnswer = z.infer<typeof assistantAnswerSchema>;
