import { z } from 'zod';

const fieldType = z.enum(['string', 'number', 'boolean', 'null']);
const scalar = z.union([
  z.string().max(2000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const key = z.string().max(80);
const text = z.string().max(2000);
const number = z.number().finite();
const fields = z.record(key, fieldType);
const value = z.discriminatedUnion('source', [
  z.object({ source: z.literal('input'), field: key }).strict(),
  z.object({ source: z.literal('evidence'), field: key }).strict(),
  z.object({ source: z.literal('literal'), value: scalar }).strict(),
  z.object({ source: z.literal('step'), stepId: key, field: key }).strict(),
]);
const values = z.record(key, value);
const step = z.object({ id: key });

export const workflowStepKinds = [
  'read',
  'condition',
  'capability',
  'approval',
  'wait',
  'verification',
  'escalation',
  'end',
  'code',
] as const;

export const workflowTriggerKinds = [
  'manual',
  'event',
  'schedule',
  'condition',
  'exception',
] as const;

/** One step of a draft. Values may be empty until validation passes. */
export const draftStepSchema = z.discriminatedUnion('kind', [
  step
    .extend({
      kind: z.literal('code'),
      source: z.string().max(32768),
      fields,
      grants: z.array(key).max(16),
      limits: z
        .object({
          fuel: number,
          memoryBytes: number,
          wallTimeMs: number,
          maxRequests: number,
        })
        .strict(),
    })
    .strict(),
  step.extend({ kind: z.literal('read'), source: text, fields }).strict(),
  step
    .extend({
      kind: z.literal('condition'),
      field: key,
      equals: scalar,
      onFalse: z.enum(['escalate', 'end']),
    })
    .strict(),
  step
    .extend({
      kind: z.literal('capability'),
      capability: text,
      capabilityVersion: text,
      targetKind: text,
      minimumRisk: z.enum(['low', 'medium', 'high']),
      parameters: values,
      expectedPostcondition: values,
    })
    .strict(),
  step
    .extend({
      kind: z.literal('approval'),
      forStep: key,
      expiresAfterSeconds: number,
    })
    .strict(),
  step.extend({ kind: z.literal('wait'), seconds: number }).strict(),
  step
    .extend({
      kind: z.literal('verification'),
      forStep: key,
      evaluatorVersion: text,
      maxDurationSeconds: number,
      fields,
    })
    .strict(),
  step.extend({ kind: z.literal('escalation'), reason: text }).strict(),
  step.extend({ kind: z.literal('end'), outcome: text }).strict(),
]);

/** Authored `workflow/2` content shared by the builder, code view and generator. */
export const workflowDraftContentSchema = z
  .object({
    schemaVersion: z.literal(2),
    definition: z
      .object({ id: key, name: text, intent: text, category: text })
      .strict(),
    version: text,
    applicability: z
      .object({
        trigger: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('exception'), issueType: text }).strict(),
          z.object({ kind: z.literal('manual') }).strict(),
          z.object({ kind: z.literal('event'), eventType: text }).strict(),
          z.object({ kind: z.literal('schedule'), at: text }).strict(),
          z
            .object({
              kind: z.literal('condition'),
              field: key,
              equals: scalar,
            })
            .strict(),
        ]),
        subjectKind: text,
      })
      .strict(),
    inputs: fields,
    context: z.object({ kind: text, fields, maxAgeSeconds: number }).strict(),
    steps: z.array(draftStepSchema).max(32),
  })
  .strict();

export const authoringModeSchema = z.enum([
  'template',
  'visual',
  'code',
  'language',
]);

export const workflowDraftSchema = z.object({
  id: z.string().uuid(),
  revision: z.number().int().positive(),
  state: z.enum(['draft', 'published', 'discarded']),
  mode: authoringModeSchema,
  content: workflowDraftContentSchema,
  codeView: z.string().nullable(),
  basedOn: z
    .object({
      definitionId: z.string(),
      version: z.string(),
      digest: z.string(),
    })
    .nullable(),
  authorId: z.string(),
  updatedBy: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  published: z
    .object({
      version: z.string(),
      digest: z.string(),
      publishedAt: z.string().datetime(),
      publishedBy: z.string(),
    })
    .nullable(),
});

export const workflowDiagnosticSchema = z.object({
  severity: z.enum(['error', 'warning']),
  code: z.string(),
  stepIndex: z.number().int().nonnegative().nullable(),
  stepId: z.string().nullable(),
  field: z.string().nullable(),
  message: z.string(),
  detail: z.string(),
});

export const valueOptionSchema = z.object({
  source: z.enum(['input', 'evidence', 'step']),
  stepId: z.string().nullable(),
  field: z.string(),
  type: fieldType,
});

export const draftValidationSchema = z.object({
  revision: z.number().int().positive().nullable(),
  content: workflowDraftContentSchema.nullable(),
  publishable: z.boolean(),
  diagnostics: z.array(workflowDiagnosticSchema),
  steps: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      id: z.string(),
      kind: z.enum(workflowStepKinds),
      title: z.string(),
      description: z.string(),
      scope: z.array(valueOptionSchema),
    }),
  ),
  summary: z.string().nullable(),
  printed: z.string().nullable(),
  publishedVersions: z.array(z.string()),
  suggestedVersion: z.string(),
});

const availability = {
  executable: z.boolean(),
  reason: z.string().nullable(),
};

export const authoringVocabularySchema = z.object({
  triggers: z.array(
    z.object({
      kind: z.enum(workflowTriggerKinds),
      label: z.string(),
      description: z.string(),
      ...availability,
    }),
  ),
  stepKinds: z.array(
    z.object({
      kind: z.enum(workflowStepKinds),
      label: z.string(),
      description: z.string(),
      ...availability,
    }),
  ),
  subjects: z.array(
    z.object({
      kind: z.string(),
      label: z.string(),
      description: z.string(),
      ...availability,
    }),
  ),
  reads: z.array(
    z.object({
      source: z.string(),
      label: z.string(),
      description: z.string(),
      fields: z.record(z.string(), fieldType),
      ...availability,
    }),
  ),
  capabilities: z.array(
    z.object({
      capability: z.string(),
      version: z.string(),
      label: z.string(),
      description: z.string(),
      targetKind: z.string(),
      minimumRisk: z.enum(['low', 'medium', 'high']),
      approval: z.string(),
      parameters: z.record(z.string(), fieldType),
      postcondition: z.record(z.string(), fieldType),
      evaluators: z.array(z.string()),
      ...availability,
    }),
  ),
  evaluators: z.array(
    z.object({
      version: z.string(),
      label: z.string(),
      description: z.string(),
      fields: z.record(z.string(), fieldType),
      ...availability,
    }),
  ),
  codeSteps: z.object({
    ...availability,
    evaluation: z.boolean(),
    runtime: z.string(),
    limits: z.object({
      fuel: z.number(),
      memoryBytes: z.number(),
      wallTimeMs: z.number(),
      maxRequests: z.number(),
    }),
  }),
});

const content = z.record(z.string(), z.unknown());

/** Start a draft from scratch, from supplied content, or from a published version to edit it. */
export const createWorkflowDraftSchema = z
  .object({
    id: z.string().uuid(),
    mode: authoringModeSchema,
    start: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('blank'),
          name: z.string().max(200).optional(),
        })
        .strict(),
      z.object({ kind: z.literal('content'), content }).strict(),
      z
        .object({
          kind: z.literal('template'),
          templateId: z.string().regex(/^[a-z][a-zA-Z0-9_-]{0,79}$/),
        })
        .strict(),
      z
        .object({
          kind: z.literal('version'),
          definitionId: z.string().regex(/^[a-z][a-zA-Z0-9_-]{0,79}$/),
          version: z.string().max(200),
        })
        .strict(),
    ]),
  })
  .strict();

/** Save against the revision you loaded. Reuse the same save ID and body after an uncertain response. */
export const saveWorkflowDraftSchema = z
  .object({
    saveId: z.string().uuid(),
    revision: z.number().int().positive(),
    mode: authoringModeSchema,
    content,
    codeView: z.string().max(262_144).nullable().optional(),
  })
  .strict();

/** Check a saved draft, supplied content, or code view text. Code takes precedence over content. */
export const validateWorkflowDraftSchema = z
  .object({
    draftId: z.string().uuid().optional(),
    content: content.optional(),
    code: z.string().max(262_144).optional(),
  })
  .strict()
  .refine((body) => body.draftId || body.content || body.code !== undefined, {
    message: 'Provide a draft ID, content or code.',
  });

export const publishWorkflowDraftSchema = z
  .object({
    revision: z.number().int().positive(),
    notes: z.string().max(2000).optional(),
  })
  .strict();

export const publishedDraftSchema = z.object({
  draft: workflowDraftSchema,
  version: z.object({
    definitionId: z.string(),
    version: z.string(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  }),
});

/** A published definition offered in the New workflow gallery, with what it needs here. */
export const workflowTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  purpose: z.string(),
  category: z.enum([
    'procurement',
    'resolution',
    'inventory',
    'fulfillment',
    'orders',
    'returns',
    'connections',
  ]),
  trigger: z.string(),
  steps: z.array(z.string()),
  success: z.string(),
  requirements: z.array(
    z.object({
      label: z.string(),
      met: z.boolean(),
      detail: z.string(),
      fix: z
        .object({
          label: z.string(),
          destination: z.enum(['procurement', 'connections', 'workflow']),
        })
        .nullable(),
    }),
  ),
  readiness: z.enum(['ready', 'blocked']),
  status: z.enum(['active', 'inactive', 'revoked', 'unavailable']),
  /** `case` turns on a workflow that starts for each new case of its issue type. */
  configure: z.enum(['replenishment', 'resolution', 'case']),
  installed: z.boolean(),
  version: z.string(),
  digest: z.string(),
});

export type WorkflowTemplate = z.infer<typeof workflowTemplateSchema>;

export type WorkflowDraftContent = z.infer<typeof workflowDraftContentSchema>;

export type DraftStep = z.infer<typeof draftStepSchema>;

export type WorkflowDraft = z.infer<typeof workflowDraftSchema>;

export type WorkflowDiagnostic = z.infer<typeof workflowDiagnosticSchema>;

export type DraftValidation = z.infer<typeof draftValidationSchema>;

export type AuthoringVocabulary = z.infer<typeof authoringVocabularySchema>;

export type ValueOption = z.infer<typeof valueOptionSchema>;

export type AuthoringMode = z.infer<typeof authoringModeSchema>;

export type CreateWorkflowDraft = z.infer<typeof createWorkflowDraftSchema>;

export type SaveWorkflowDraft = z.infer<typeof saveWorkflowDraftSchema>;
