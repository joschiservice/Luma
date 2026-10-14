// Model answers for the authoring E2E server. Drafts use only the default installed vocabulary.
export const authoringModel = 'au.anthropic.claude-sonnet-4-5-20250929-v1:0';

/** A replenishment draft with an approval before the order. */
export const describedDraft = {
  schemaVersion: 2,
  definition: {
    id: 'low-stock',
    name: 'Reorder low stock',
    intent: 'Draft a purchase order when stock is low and ask for approval.',
    category: 'procurement',
  },
  version: '1.0.0',
  applicability: {
    trigger: { kind: 'condition', field: 'belowMinimum', equals: true },
    subjectKind: 'inventory_position',
  },
  inputs: {},
  context: {
    kind: 'replenishment',
    fields: { belowMinimum: 'boolean' },
    maxAgeSeconds: 300,
  },
  steps: [
    {
      id: 'inventory',
      kind: 'read',
      source: 'inventory',
      fields: { fresh: 'boolean', available: 'number' },
    },
    {
      id: 'fresh-stock',
      kind: 'condition',
      field: 'fresh',
      equals: true,
      onFalse: 'escalate',
    },
    {
      id: 'proposal',
      kind: 'read',
      source: 'procurement.replenishment',
      fields: { eligible: 'boolean', quantity: 'number' },
    },
    {
      id: 'needs-order',
      kind: 'condition',
      field: 'eligible',
      equals: true,
      onFalse: 'end',
    },
    {
      id: 'approve-order',
      kind: 'approval',
      forStep: 'create-order',
      expiresAfterSeconds: 86_400,
    },
    {
      id: 'create-order',
      kind: 'capability',
      capability: 'procurement.purchase-order.create',
      capabilityVersion: '1',
      targetKind: 'purchase_order',
      minimumRisk: 'medium',
      parameters: {
        quantity: { source: 'step', stepId: 'proposal', field: 'quantity' },
      },
      expectedPostcondition: { status: { source: 'literal', value: 'draft' } },
    },
    {
      id: 'verify-order',
      kind: 'verification',
      forStep: 'create-order',
      evaluatorVersion: 'procurement/1',
      maxDurationSeconds: 60,
      fields: { status: 'string' },
    },
    { id: 'complete', kind: 'end', outcome: 'Purchase order drafted' },
  ],
};
