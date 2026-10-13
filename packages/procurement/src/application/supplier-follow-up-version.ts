import type { ProcessWorkflowVersion } from '@luma/workflows';

const orderFields = {
  ready: 'boolean',
  waiting: 'boolean',
  key: 'string',
  orderRevision: 'number',
  scopeFingerprint: 'string',
} as const;

/**
 * Follows up on a sent purchase order the supplier hasn't confirmed in time, or whose delivery is
 * past its expected date. Luma records the follow-up on the order, so the buyer isn't asked while
 * it waits, then checks again and hands the order back to the buyer if the supplier is still
 * silent. Nothing is sent to the supplier or the purchasing system.
 */
export function supplierFollowUpSource(
  waitSeconds: number,
): Omit<ProcessWorkflowVersion, 'digest' | 'format'> {
  return {
    schemaVersion: 2,
    definition: {
      id: 'supplier-follow-up',
      name: 'Follow up on an overdue supplier order',
      intent:
        'When a supplier hasn’t confirmed a sent order in time, or a delivery is past its expected date, note the follow-up on the order, wait, check again and hand it back to a buyer if the supplier is still silent. Nothing is sent to the supplier.',
      category: 'procurement',
    },
    version: '1.1.0',
    applicability: {
      trigger: { kind: 'event', eventType: 'supplier_order_overdue' },
      subjectKind: 'purchase_order',
    },
    inputs: { activationId: 'string', signalId: 'string' },
    context: {
      kind: 'supplier_order_overdue',
      fields: { severity: 'string' },
      maxAgeSeconds: 300,
    },
    steps: [
      {
        id: 'order',
        kind: 'read',
        source: 'procurement.purchase-order',
        fields: orderFields,
      },
      {
        id: 'found',
        kind: 'condition',
        field: 'ready',
        equals: true,
        onFalse: 'escalate',
      },
      {
        id: 'still-waiting',
        kind: 'condition',
        field: 'waiting',
        equals: true,
        onFalse: 'end',
      },
      {
        id: 'record-follow-up',
        kind: 'capability',
        capability: 'procurement.follow-up.record',
        capabilityVersion: '0',
        targetKind: 'purchase_order',
        minimumRisk: 'low',
        parameters: { key: { source: 'step', stepId: 'order', field: 'key' } },
        expectedPostcondition: {
          recorded: { source: 'literal', value: true },
        },
      },
      {
        id: 'check-follow-up',
        kind: 'verification',
        forStep: 'record-follow-up',
        evaluatorVersion: 'procurement-follow-up-recorded/1',
        maxDurationSeconds: 60,
        fields: { recorded: 'boolean' },
      },
      { id: 'give-time', kind: 'wait', seconds: waitSeconds },
      {
        id: 'recheck',
        kind: 'read',
        source: 'procurement.purchase-order',
        fields: orderFields,
      },
      {
        id: 'answered',
        kind: 'condition',
        field: 'waiting',
        equals: false,
        onFalse: 'escalate',
      },
      {
        id: 'done',
        kind: 'end',
        outcome: 'The supplier answered while Luma waited',
      },
    ],
    provenance: {
      kind: 'native',
      reference: 'procurement-follow-ups/1',
      authoredBy: 'Luma',
      evidenceRefs: ['procurement-follow-up-recorded/1'],
    },
  };
}
