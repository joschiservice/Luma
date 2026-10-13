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

/** Who answers the dispatch task and who takes it over once it is overdue. */
export const dispatchTask = {
  assignee: { kind: 'role', key: 'member' },
  escalationTarget: { kind: 'role', key: 'admin' },
  dueAfterSeconds: 4 * 60 * 60,
  adjusted: 'Adjusted',
  notAdjusted: 'Cannot adjust',
} as const;

/**
 * Carries an order line quantity that detection found differing between systems to dispatch and
 * Shopify. The warehouse makes dispatch carry the authoritative quantity, because Luma cannot
 * write dispatch records; a fresh plan must then show the change safe before Luma proposes the
 * Shopify edit, which someone else approves. Fresh reads of every system confirm the outcome,
 * and the run never closes the case.
 */
export const quantityChangeSource = {
  schemaVersion: 2,
  definition: {
    id: 'order-quantity-change',
    name: 'Carry an order quantity change to every system',
    intent:
      'When an order line shows a different quantity in Shopify than in the system that holds order-line authority, ask the warehouse to make dispatch carry the new quantity, check fresh reads, propose the Shopify edit, wait for someone else who can approve changes, and confirm the quantity with fresh reads of every system.',
    category: 'orders',
  },
  version: '1.0.0',
  applicability: {
    trigger: { kind: 'exception', issueType: 'order_quantity_mismatch' },
    subjectKind: 'order',
  },
  inputs: caseInputs,
  context: {
    kind: 'order_quantity_mismatch',
    fields: { severity: 'string' },
    maxAgeSeconds: 300,
  },
  steps: [
    {
      id: 'plan',
      kind: 'read',
      source: 'orders.change-plan',
      fields: {
        ready: 'boolean',
        targetQuantity: 'number',
        workStarted: 'boolean',
        problem: 'string',
      },
    },
    {
      id: 'plan-usable',
      kind: 'condition',
      field: 'ready',
      equals: true,
      onFalse: 'escalate',
    },
    {
      id: 'dispatch',
      kind: 'human_task',
      assignee: dispatchTask.assignee,
      instructions:
        'A customer’s quantity change must reach dispatch. Open the order and read its change plan for the line and the new quantity. In the dispatch system, update the order to the new quantity. If picking or packing has started, adjust the pick to the new quantity, or cancel the open delivery note so the order is picked again. Answer Adjusted once dispatch carries the new quantity, or Cannot adjust if the parcel can no longer change. Luma rereads every system before it changes Shopify.',
      choices: [dispatchTask.adjusted, dispatchTask.notAdjusted],
      evidence: 'text',
      dueAfterSeconds: dispatchTask.dueAfterSeconds,
      escalationTarget: dispatchTask.escalationTarget,
    },
    {
      id: 'dispatch-adjusted',
      kind: 'condition',
      field: 'choice',
      equals: dispatchTask.adjusted,
      onFalse: 'escalate',
    },
    {
      id: 'replan',
      kind: 'read',
      source: 'orders.change-plan',
      fields: {
        ready: 'boolean',
        safe: 'boolean',
        shopifyDiffers: 'boolean',
        targetQuantity: 'number',
        workStarted: 'boolean',
        problem: 'string',
      },
    },
    {
      id: 'shopify-differs',
      kind: 'condition',
      field: 'shopifyDiffers',
      equals: true,
      onFalse: 'end',
    },
    {
      id: 'safe-now',
      kind: 'condition',
      field: 'safe',
      equals: true,
      onFalse: 'escalate',
    },
    {
      id: 'edit-shopify',
      kind: 'capability',
      capability: 'orders.quantity.edit',
      capabilityVersion: '0',
      targetKind: 'shopify_order_edit',
      minimumRisk: 'medium',
      parameters: {
        quantity: { source: 'step', stepId: 'replan', field: 'targetQuantity' },
      },
      expectedPostcondition: {
        quantity: { source: 'step', stepId: 'replan', field: 'targetQuantity' },
      },
    },
    {
      id: 'check-everywhere',
      kind: 'verification',
      forStep: 'edit-shopify',
      evaluatorVersion: 'order-quantity-agreement/1',
      maxDurationSeconds: 300,
      recheck: { attempts: 4, intervalSeconds: 30 },
      fields: {
        quantity: 'number',
        agreed: 'boolean',
        reporting: 'number',
        notReporting: 'number',
      },
    },
    {
      id: 'done',
      kind: 'end',
      outcome:
        'Every system that reports the line shows the new quantity in fresh reads; detection closes the case',
    },
  ],
  provenance: {
    ...provenance,
    evidenceRefs: ['order-quantity-agreement/1'],
  },
};
