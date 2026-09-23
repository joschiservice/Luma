import type { PlaybookVersion } from './playbook.js';

/** The pilot correction verifies the selected method; fulfillment needs separate evidence. */
export const shippingMethodPlaybook: Omit<PlaybookVersion, 'digest'> = {
  definition: {
    id: 'shipping-method-correction',
    name: 'Correct an order shipping method',
    intent:
      'Apply the mapped shipping method to an eligible order and verify the correction.',
  },
  version: '0.1.0',
  compatibility: { interpreter: 'resolution-playbook/0', admission: 1 },
  provenance: {
    kind: 'pilot',
    reference: 'LUMA-41: synthetic JTL shipping-method correction',
    authoredBy: 'luma',
    evidenceRefs: ['tooling/pilot/runtime.mjs', 'docs/pilot-environment.md'],
  },
  ir: {
    schemaVersion: 1,
    inputs: { shippingMethodId: 'string' },
    evidence: {
      kind: 'workflow_failure',
      fields: { diagnosisReady: 'boolean', methodMapped: 'boolean' },
      maxAgeSeconds: 300,
    },
    eligibility: {
      id: 'eligible',
      kind: 'eligibility',
      all: [
        { field: 'diagnosisReady', equals: true },
        { field: 'methodMapped', equals: true },
      ],
    },
    action: {
      id: 'correct-shipping-method',
      kind: 'capability',
      capability: 'orders.shipping-method.write',
      capabilityVersion: '0',
      targetKind: 'order',
      minimumRisk: 'high',
      parameters: {},
      expectedPostcondition: {
        shippingMethodId: { source: 'input', field: 'shippingMethodId' },
      },
    },
    approval: { id: 'approve', kind: 'approval', mode: 'required' },
    verification: {
      id: 'verify-correction',
      kind: 'verification',
      evaluatorVersion: 'shipping-method/1',
      maxDurationSeconds: 300,
      maxAttempts: 1,
    },
    recovery: {
      id: 'review',
      kind: 'escalation',
      strategy: 'reconcile_then_escalate',
    },
  },
};
