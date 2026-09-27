import type { ProcessWorkflowVersion } from './process.js';

/** A representative source used by compiler and runtime tests. */
export const processSource = {
  schemaVersion: 2 as const,
  definition: {
    id: 'replenish',
    name: 'Replenish',
    intent: 'Restore stock',
    category: 'procurement',
  },
  version: '1.0.0',
  applicability: { trigger: { kind: 'manual' as const }, subjectKind: 'order' },
  inputs: { quantity: 'number' as const },
  context: {
    kind: 'inventory',
    fields: { ready: 'boolean' as const },
    maxAgeSeconds: 300,
  },
  steps: [
    {
      id: 'refresh',
      kind: 'read' as const,
      source: 'inventory',
      fields: { ready: 'boolean' as const },
    },
    {
      id: 'eligible',
      kind: 'condition' as const,
      field: 'ready',
      equals: true,
      onFalse: 'escalate' as const,
    },
    {
      id: 'review',
      kind: 'approval' as const,
      forStep: 'reserve',
      expiresAfterSeconds: 3600,
    },
    {
      id: 'reserve',
      kind: 'capability' as const,
      capability: 'stock.reserve',
      capabilityVersion: '1',
      targetKind: 'order',
      minimumRisk: 'medium' as const,
      parameters: { quantity: { source: 'input' as const, field: 'quantity' } },
      expectedPostcondition: {
        reserved: { source: 'literal' as const, value: true },
      },
    },
    {
      id: 'verify',
      kind: 'verification' as const,
      forStep: 'reserve',
      evaluatorVersion: '1',
      maxDurationSeconds: 60,
      fields: { reserved: 'boolean' as const },
    },
    { id: 'settle', kind: 'wait' as const, seconds: 5 },
    { id: 'finish', kind: 'end' as const, outcome: 'reserved' },
  ],
  provenance: {
    kind: 'resolution' as const,
    reference: 'ops',
    authoredBy: 'operator',
    evidenceRefs: ['inventory'],
  },
};

/** A bound version for interpreter tests; compiler tests compute the real digest. */
export const processVersion: ProcessWorkflowVersion = {
  ...processSource,
  format: 'workflow/2',
  digest: 'a'.repeat(64),
};
