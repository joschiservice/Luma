import { z } from 'zod';

import {
  playbookActivationSchema,
  playbookDetailSchema,
  playbookRunViewSchema,
  playbookSummarySchema,
  playbookVersionViewSchema,
} from './playbooks.js';

const text = z.string().min(1);

export const workflowTriggerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('exception'), issueType: text }),
  z.object({ kind: z.literal('manual') }),
  z.object({ kind: z.literal('event'), eventType: text }),
]);

export const workflowActorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), id: text }),
  z.object({
    kind: z.literal('agent'),
    id: text,
    operatorId: text,
    grantId: text,
  }),
]);
const fields = z.record(text, z.enum(['string', 'number', 'boolean', 'null']));

export const workflowVersionViewSchema = playbookVersionViewSchema
  .omit({ issueType: true })
  .extend({
    category: text,
    format: z.enum(['workflow/1', 'resolution-playbook/0']),
    applicability: z.object({
      trigger: workflowTriggerSchema,
      subjectKind: text,
    }),
    inputs: fields,
    context: z.object({
      kind: text,
      fields,
      maxAgeSeconds: z.number().int().positive(),
    }),
    policy: z.object({
      approval: z.enum(['policy', 'required']),
      minimumRisk: z.enum(['low', 'medium', 'high']),
    }),
    outcome: z.object({
      kind: z.literal('verified_postcondition'),
      evaluatorVersion: text,
      onUnverified: z.literal('escalate'),
    }),
  });

export const workflowSummarySchema = playbookSummarySchema
  .omit({ issueType: true })
  .extend({ category: text });

export const workflowDetailSchema = playbookDetailSchema.extend({
  summary: workflowSummarySchema,
  versions: z.array(workflowVersionViewSchema),
  policyVersion: z.string(),
});

export const workflowRunViewSchema = playbookRunViewSchema
  .omit({ incidentId: true })
  .extend({
    trigger: workflowTriggerSchema,
    subject: z.object({ kind: text, id: text }),
    actor: workflowActorSchema,
    resolution: z
      .object({
        incidentId: z.string().uuid(),
        diagnosisRevision: z.number().int().nonnegative(),
      })
      .optional(),
    contextDigest: z.string().regex(/^[a-f0-9]{64}$/),
    steps: z.array(
      z.object({
        stepId: text,
        state: text,
        reason: text,
        proposalId: z.string().uuid(),
        decisionId: z.string().nullable(),
      }),
    ),
  });

export const workflowActivationSchema = playbookActivationSchema;

export { activatePlaybookSchema as activateWorkflowSchema } from './playbooks.js';

export type WorkflowSummary = z.infer<typeof workflowSummarySchema>;

export type WorkflowDetail = z.infer<typeof workflowDetailSchema>;

export type WorkflowVersionView = z.infer<typeof workflowVersionViewSchema>;

export type WorkflowRunView = z.infer<typeof workflowRunViewSchema>;

export type WorkflowActor = z.infer<typeof workflowActorSchema>;

export type WorkflowTrigger = z.infer<typeof workflowTriggerSchema>;

export type {
  ActivatePlaybook as ActivateWorkflow,
  PlaybookActivationView as WorkflowActivationView,
  PlaybookConnection as WorkflowConnection,
} from './playbooks.js';
