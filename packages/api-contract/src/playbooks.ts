import { z } from 'zod';

const text = z.string().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/);

export const playbookActivationSchema = z.object({
  id: z.string().uuid(),
  version: text,
  versionDigest: digest,
  artifactDigest: digest,
  policyVersion: text,
  active: z.boolean(),
  grants: z.object({
    principalIds: z.array(text),
    connectionIds: z.array(z.string().uuid()),
    targetIds: z.array(z.string().uuid()),
  }),
  reviewedBy: z.string().nullable(),
  reviewedAt: z.string().datetime().nullable(),
});

export const playbookVersionViewSchema = z.object({
  version: text,
  digest,
  compatible: z.boolean(),
  blockers: z.array(text),
  capability: text,
  capabilityVersion: text,
  targetKind: text,
  issueType: text,
  systems: z.array(text),
  approval: text,
  permissions: z.array(text),
  steps: z.array(
    z.object({
      id: text,
      /** The step's exact technical identity, such as its capability and version. */
      reference: text.optional(),
      title: text,
      description: text,
      details: z.array(text),
    }),
  ),
  provenance: z.object({
    kind: z.enum(['pilot', 'resolution', 'native']),
    reference: text,
    authoredBy: text,
    evidenceRefs: z.array(text),
  }),
  representation: z.string(),
});

const playbookConnectionSchema = z.object({
  id: z.string().uuid(),
  label: text,
  system: text,
  version: z.number().int(),
  blockers: z.array(text),
  targets: z.array(z.object({ id: z.string().uuid(), label: text })),
});

export const playbookRunViewSchema = z.object({
  id: z.string().uuid(),
  incidentId: z.string().uuid(),
  createdAt: z.string().datetime(),
  version: text,
  versionDigest: digest,
  activationId: z.string().uuid(),
  evidenceKind: z.enum([
    'pilot',
    'live',
    'simulation',
    'shadow',
    'unclassified',
  ]),
  execution: text,
  verification: text,
  reason: text,
});

export const playbookSummarySchema = z.object({
  id: text,
  name: text,
  purpose: text,
  capability: text,
  issueType: text,
  systems: z.array(text),
  availableVersion: text,
  status: z.enum(['active', 'inactive', 'revoked', 'unavailable']),
  blockers: z.array(text),
  activeVersions: z.array(text),
});

export const playbookDetailSchema = z.object({
  summary: playbookSummarySchema,
  versions: z.array(playbookVersionViewSchema),
  connections: z.array(playbookConnectionSchema),
  activations: z.array(playbookActivationSchema),
  policyVersion: text,
  principalId: text,
  canManage: z.boolean(),
  evaluationEvidence: z.literal('unavailable'),
});

export const activatePlaybookSchema = z
  .object({
    id: z.string().uuid(),
    version: text,
    reviewedDigest: digest,
    policyVersion: text,
    connectionId: z.string().uuid(),
    connectionVersion: z.number().int().positive(),
    targetIds: z
      .array(z.string().uuid())
      .min(1)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length),
    scopeReviewed: z.literal(true),
  })
  .strict();

export type PlaybookActivationView = z.infer<typeof playbookActivationSchema>;

export type ActivatePlaybook = z.infer<typeof activatePlaybookSchema>;
