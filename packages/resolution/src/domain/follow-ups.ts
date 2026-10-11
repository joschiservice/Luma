import type { ProcessWorkflowVersion } from '@luma/workflows';

type Source = Omit<ProcessWorkflowVersion, 'digest' | 'format'>;

const provenance: Source['provenance'] = {
  kind: 'native',
  reference: 'resolution-follow-ups/1',
  authoredBy: 'Luma',
  evidenceRefs: ['read-models-v1'],
};

const signalInputs = { activationId: 'string', signalId: 'string' } as const;

/** Builds a follow-up that rereads its record and hands it to a person while it is still open. */
function followUp(input: {
  id: string;
  name: string;
  intent: string;
  category: string;
  eventType: string;
  subjectKind: string;
  read: { id: string; source: string; open: string };
  outcome: string;
}): Source {
  return {
    schemaVersion: 2,
    definition: {
      id: input.id,
      name: input.name,
      intent: input.intent,
      category: input.category,
    },
    version: '1.0.0',
    applicability: {
      trigger: { kind: 'event', eventType: input.eventType },
      subjectKind: input.subjectKind,
    },
    inputs: signalInputs,
    context: {
      kind: input.eventType,
      fields: { severity: 'string' },
      maxAgeSeconds: 300,
    },
    steps: [
      {
        id: input.read.id,
        kind: 'read',
        source: input.read.source,
        fields: { ready: 'boolean', [input.read.open]: 'boolean' },
      },
      {
        id: 'found',
        kind: 'condition',
        field: 'ready',
        equals: true,
        onFalse: 'escalate',
      },
      {
        id: 'settled',
        kind: 'condition',
        field: input.read.open,
        equals: false,
        onFalse: 'escalate',
      },
      { id: 'done', kind: 'end', outcome: input.outcome },
    ],
    provenance,
  };
}

/**
 * Hands a return to a person when its items arrived but no refund was recorded within the
 * waiting window. It never submits a refund automatically.
 */
export const refundFollowUpSource = followUp({
  id: 'refund-follow-up',
  name: 'Chase a refund after a return arrives',
  intent:
    'When returned items have arrived but no refund is recorded within the waiting window, check the return again and hand it to a person with the order and refund details. Luma never refunds by itself.',
  category: 'returns',
  eventType: 'refund_overdue',
  subjectKind: 'return',
  read: { id: 'return', source: 'returns.refund', open: 'waiting' },
  outcome: 'The refund was recorded before anyone needed to step in',
});

/**
 * Hands an order to a person when its payment stays pending past the waiting window. It never
 * holds or cancels the order.
 */
export const paymentFollowUpSource = followUp({
  id: 'payment-follow-up',
  name: 'Follow up on a payment that stays pending',
  intent:
    'When an order’s payment stays pending past the waiting window, check the order again and hand it to a person with the order details. Luma never holds or cancels the order.',
  category: 'orders',
  eventType: 'payment_pending',
  subjectKind: 'order',
  read: { id: 'payment', source: 'orders.payment', open: 'pending' },
  outcome: 'The payment settled before anyone needed to step in',
});

/** Follows configured case steps while their owner reports a durable unresolved wait. */
export const returnStepFollowUpSource = followUp({
  id: 'return-case-follow-up',
  name: 'Follow up on overdue return steps',
  intent:
    'Read configured receipt, inspection and financial deadlines, verify progress independently and hand overdue steps to the return case owner.',
  category: 'returns',
  eventType: 'return_step_overdue',
  subjectKind: 'return',
  read: { id: 'return', source: 'orders.return-waiting', open: 'waiting' },
  outcome: 'The case owner reported independently verified progress',
});
