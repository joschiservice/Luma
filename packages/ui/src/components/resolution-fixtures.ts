import type { CaseReview, CaseProgress } from '@luma/api-contract';
export const resolutionReview: CaseReview = {
  schemaVersion: 1,
  caseRevision: 4,
  diagnosisRevision: 2,
  permittedDecisions: ['approve', 'reject', 'escalate'],
  proposal: {
    id: '11111111-1111-4111-8111-111111111111',
    version: 1,
    diagnosisRevision: 2,
    capability: 'order.shipping_method.update',
    capabilityVersion: 'v1',
    available: true,
    connectionId: '22222222-2222-4222-8222-222222222222',
    target: { kind: 'order', id: '33333333-3333-4333-8333-333333333333' },
    parameters: { shippingMethodId: 'standard' },
    expectedPostcondition: { shippingMethodId: 'standard' },
    preconditions: {
      evidenceRefs: ['order-observation-42'],
      validUntil: '2099-01-01T00:00:00Z',
    },
    risk: 'medium',
    expiresAt: '2099-01-01T00:00:00Z',
    requestedBy: 'workflow-service',
    policy: {
      id: '44444444-4444-4444-8444-444444444444',
      policyVersion: 'v1',
      outcome: 'approval_required',
      reason:
        'Changing the shipping method requires an independent operator decision.',
      evaluatedAt: '2026-09-20T00:00:00Z',
      validUntil: '2099-01-01T00:00:00Z',
    },
    approval: null,
  },
};
export const resolutionProgress: CaseProgress = {
  schemaVersion: 1,
  caseRevision: 4,
  diagnosisRevision: 2,
  state: 'awaiting_approval',
  execution: null,
  resolution: null,
  workflow: {
    availability: 'available',
    progress: { phase: 'awaiting_approval' },
  },
};
