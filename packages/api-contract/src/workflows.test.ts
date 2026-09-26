import { expect, it } from 'vitest';

import { workflowActorSchema, workflowRunViewSchema } from './workflows.js';

it('represents subject-based runs without an Exception root', () => {
  const run = workflowRunViewSchema.parse({
    id: '11111111-1111-4111-8111-111111111111',
    createdAt: '2026-09-26T00:00:00Z',
    version: '1.0.0',
    versionDigest: 'a'.repeat(64),
    activationId: '22222222-2222-4222-8222-222222222222',
    evidenceKind: 'unclassified',
    execution: 'not_recorded',
    verification: 'not_verified',
    reason: 'Awaiting approval',
    trigger: { kind: 'manual' },
    subject: { kind: 'order', id: 'order-1' },
    actor: {
      kind: 'agent',
      id: 'agent-1',
      operatorId: 'operator-1',
      grantId: 'delegation-1',
    },
    contextDigest: 'b'.repeat(64),
    steps: [],
  });
  expect(run).not.toHaveProperty('resolution');
  expect(run.actor.kind).toBe('agent');
});

it('requires accountable operator and grant references for agent provenance', () => {
  expect(
    workflowActorSchema.safeParse({ kind: 'agent', id: 'agent-1' }).success,
  ).toBe(false);
  expect(
    workflowActorSchema.safeParse({
      kind: 'agent',
      id: 'agent-1',
      operatorId: 'operator-1',
      grantId: '',
    }).success,
  ).toBe(false);
});
