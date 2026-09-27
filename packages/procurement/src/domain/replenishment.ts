/** An immutable replenishment scope, reviewed before its workflow is activated. */
export interface ReplenishmentRule {
  id: string;
  positionId: string;
  connectionId: string;
  supplierId: string;
  minimum: number;
  target: number;
  approvalQuantity: number;
}

/** Computes a bounded order quantity; uncertain stock and existing commitments stop ordering. */
export function planReplenishment(
  rule: Pick<ReplenishmentRule, 'minimum' | 'target' | 'approvalQuantity'>,
  inventory: { available: number | null; observedAt: string; deleted: boolean },
  committed: boolean,
  now: number,
) {
  const age = now - Date.parse(inventory.observedAt);
  const fresh =
    !inventory.deleted &&
    Number.isFinite(age) &&
    age >= 0 &&
    age < 300_000 &&
    inventory.available !== null &&
    Number.isFinite(inventory.available);
  const belowMinimum = fresh && inventory.available! < rule.minimum;
  const quantity = belowMinimum
    ? Math.max(0, Math.ceil(rule.target - inventory.available!))
    : 0;
  const bounded = Number.isSafeInteger(quantity) && quantity <= 1_000_000;

  return {
    fresh,
    belowMinimum,
    committed,
    quantity: bounded ? quantity : 0,
    eligible: fresh && belowMinimum && !committed && bounded && quantity > 0,
    approvalRequired: quantity > rule.approvalQuantity,
  };
}

/** Published Procurement V0 process; the runtime resolves its reads and binds its single action. */
export const replenishmentSource = {
  schemaVersion: 2,
  definition: {
    id: 'inventory-replenishment',
    name: 'Replenish low stock',
    intent:
      'Check low stock, review existing commitments, and create a verified purchase-order draft.',
    category: 'procurement',
  },
  version: '1.0.0',
  applicability: {
    trigger: { kind: 'condition', field: 'belowMinimum', equals: true },
    subjectKind: 'inventory_position',
  },
  inputs: { activationId: 'string' },
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
      fields: {
        fresh: 'boolean',
        available: 'number',
        sku: 'string',
        unit: 'string',
      },
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
      fields: {
        eligible: 'boolean',
        committed: 'boolean',
        quantity: 'number',
        approvalRequired: 'boolean',
        supplier: 'string',
      },
    },
    {
      id: 'needs-order',
      kind: 'condition',
      field: 'eligible',
      equals: true,
      onFalse: 'end',
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
      fields: {
        purchaseOrderId: 'string',
        quantity: 'number',
        status: 'string',
      },
    },
    {
      id: 'complete',
      kind: 'end',
      outcome: 'Purchase-order draft created and independently verified',
    },
  ],
  provenance: {
    kind: 'native',
    reference: 'procurement-v0',
    authoredBy: 'Luma',
    evidenceRefs: ['procurement/1'],
  },
};
