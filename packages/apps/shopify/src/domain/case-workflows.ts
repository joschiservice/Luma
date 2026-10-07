const provenance = {
  kind: 'native',
  reference: 'shopify-case-workflows/1',
  authoredBy: 'Luma',
} as const;

const caseInputs = { activationId: 'string', caseId: 'string' } as const;

/**
 * Corrects Shopify's available quantity to the ERP's when detection confirms a mismatch between
 * linked stock. The correction service binds the quantity, approval, compare-and-set write and
 * reconciliation; the run never closes the case.
 */
export const stockCorrectionSource = {
  schemaVersion: 2,
  definition: {
    id: 'shopify-stock-correction',
    name: 'Correct Shopify stock from the ERP',
    intent:
      'When Shopify shows a different available quantity than the ERP for linked stock, propose setting Shopify to the ERP quantity, wait for someone else who can approve changes to approve, and confirm the quantity with a fresh Shopify read.',
    category: 'inventory',
  },
  version: '1.0.0',
  applicability: {
    trigger: { kind: 'exception', issueType: 'inventory_mismatch' },
    subjectKind: 'inventory_position',
  },
  inputs: caseInputs,
  context: {
    kind: 'inventory_mismatch',
    fields: { severity: 'string' },
    maxAgeSeconds: 300,
  },
  steps: [
    {
      id: 'stock',
      kind: 'read',
      source: 'shopify.stock-sources',
      fields: {
        ready: 'boolean',
        differs: 'boolean',
        erpAvailable: 'number',
        shopifyAvailable: 'number',
        problem: 'string',
      },
    },
    {
      id: 'usable-evidence',
      kind: 'condition',
      field: 'ready',
      equals: true,
      onFalse: 'escalate',
    },
    {
      id: 'still-different',
      kind: 'condition',
      field: 'differs',
      equals: true,
      onFalse: 'end',
    },
    {
      id: 'correct-stock',
      kind: 'capability',
      capability: 'inventory.available.reconcile',
      capabilityVersion: '0',
      targetKind: 'shopify_inventory_correction',
      minimumRisk: 'medium',
      parameters: {
        available: { source: 'step', stepId: 'stock', field: 'erpAvailable' },
      },
      expectedPostcondition: {
        available: { source: 'step', stepId: 'stock', field: 'erpAvailable' },
      },
    },
    {
      id: 'check-stock',
      kind: 'verification',
      forStep: 'correct-stock',
      evaluatorVersion: 'shopify-inventory-reconciliation/1',
      maxDurationSeconds: 120,
      fields: { available: 'number' },
    },
    {
      id: 'done',
      kind: 'end',
      outcome: 'Shopify shows the ERP quantity, confirmed by a fresh read',
    },
  ],
  provenance: {
    ...provenance,
    evidenceRefs: ['shopify-inventory-reconciliation/1'],
  },
};

/**
 * Releases a Shopify fulfillment hold that keeps an order from progressing past the stuck window.
 * Success is the hold's absence in a fresh read; warehouse progress stays with detection.
 */
export const holdReleaseSource = {
  schemaVersion: 2,
  definition: {
    id: 'shopify-hold-release',
    name: 'Release an overdue fulfillment hold',
    intent:
      'When a Shopify fulfillment order stays on hold past the stuck window, propose releasing the hold, wait for someone else who can approve changes to approve, and confirm in Shopify that it was released.',
    category: 'fulfillment',
  },
  version: '1.0.0',
  applicability: {
    trigger: { kind: 'exception', issueType: 'stuck_fulfillment' },
    subjectKind: 'fulfillment',
  },
  inputs: caseInputs,
  context: {
    kind: 'stuck_fulfillment',
    fields: { severity: 'string' },
    maxAgeSeconds: 300,
  },
  steps: [
    {
      id: 'hold',
      kind: 'read',
      source: 'shopify.fulfillment-holds',
      fields: {
        ready: 'boolean',
        held: 'boolean',
        releasable: 'boolean',
        reason: 'string',
        problem: 'string',
      },
    },
    {
      id: 'readable',
      kind: 'condition',
      field: 'ready',
      equals: true,
      onFalse: 'escalate',
    },
    {
      id: 'is-held',
      kind: 'condition',
      field: 'held',
      equals: true,
      onFalse: 'end',
    },
    {
      id: 'one-hold',
      kind: 'condition',
      field: 'releasable',
      equals: true,
      onFalse: 'escalate',
    },
    {
      id: 'release-hold',
      kind: 'capability',
      capability: 'fulfillment.hold.release',
      capabilityVersion: '0',
      targetKind: 'shopify_fulfillment',
      minimumRisk: 'medium',
      parameters: {
        reason: { source: 'step', stepId: 'hold', field: 'reason' },
      },
      expectedPostcondition: { held: { source: 'literal', value: false } },
    },
    {
      id: 'check-hold',
      kind: 'verification',
      forStep: 'release-hold',
      evaluatorVersion: 'shopify-hold-released/1',
      maxDurationSeconds: 120,
      fields: { held: 'boolean' },
    },
    {
      id: 'done',
      kind: 'end',
      outcome:
        'The hold is released in Shopify; detection follows the warehouse progress',
    },
  ],
  provenance: { ...provenance, evidenceRefs: ['shopify-hold-released/1'] },
};

/**
 * Hold reasons a person can resolve by reviewing and releasing. Payment, address and stock holds
 * need their cause fixed first, so a release would only hide it.
 */
export const releasableHoldReasons: readonly string[] = [
  'HIGH_RISK_OF_FRAUD',
  'OTHER',
];
