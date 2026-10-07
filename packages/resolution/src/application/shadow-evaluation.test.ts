import type { Diagnosis } from '@luma/exceptions';
import type { PlaybookRun } from '@luma/workflows';
import { describe, expect, it } from 'vitest';

import type { ShadowComparison } from '../application/shadow-evaluation.js';
import { evaluateShadow } from '../application/shadow-evaluation.js';
import { shadowMetrics } from '../domain/shadow.js';
import { shippingMethodPlaybook } from '../domain/shipping-method-playbook.js';

const now = '2026-09-23T12:00:00.000Z';
const candidate: PlaybookRun = {
  id: 'proposal',
  tenantId: 'tenant',
  principalId: 'operator',
  activationId: 'activation',
  definitionId: 'shipping-method-correction',
  version: '0.1.0',
  versionDigest: 'digest',
  artifactDigest: 'artifact',
  incidentId: 'incident',
  diagnosisRevision: 1,
  snapshotDigest: 'snapshot',
  actionHash: 'action',
  createdAt: now,
  snapshot: {
    inputs: { shippingMethodId: 'mapped' },
    evidence: {
      kind: 'workflow_failure',
      facts: { diagnosisReady: true, methodMapped: true },
      observations: [{ id: 'evidence', observedAt: now, source: 'jtl' }],
    },
    provenance: { capturedAt: now, reference: 'production' },
  },
  action: {
    schemaVersion: 1,
    id: 'proposal',
    tenantId: 'tenant',
    capability: 'orders.shipping-method.write',
    capabilityVersion: '0',
    connectionId: 'connection',
    target: { kind: 'order', id: 'order' },
    parameters: {},
    expectedPostcondition: { shippingMethodId: 'mapped' },
    risk: 'high',
    proposedBy: { kind: 'user', id: 'operator' },
    expiresAt: '2026-09-23T12:05:00.000Z',
    preconditions: {
      evidenceRefs: ['evidence'],
      validUntil: '2026-09-23T12:05:00.000Z',
    },
  },
};
const diagnosis = {
  revision: 1,
  status: 'ready',
  superseded: false,
  provenance: { validUntil: '2026-09-23T12:05:00.000Z' },
  detectorDecision: { decision: 'detect' },
} as Diagnosis;

function input() {
  return {
    id: 'shadow',
    incidentId: 'incident',
    actorId: 'operator',
    access: new Set<string>(['actions.execute']),
    workflow: 'shipping-method-correction',
    now,
    diagnosis,
    candidate: structuredClone(candidate),
    version: { ...structuredClone(shippingMethodPlaybook), digest: 'digest' },
    available: true,
  };
}

describe('Shadow evaluation', () => {
  it('retains the bound proposal, requires approval and labels the conditional prediction', () => {
    const source = input();
    const before = structuredClone(source);
    const result = evaluateShadow(source);
    expect(source).toEqual(before);
    expect(result).toMatchObject({
      mode: 'shadow',
      executed: false,
      eligibility: 'eligible',
      policy: { outcome: 'approval_required' },
      simulation: {
        predictedOutcome: 'passed',
        effects: { shippingMethodId: 'mapped' },
      },
    });
    expect(result.simulation.assumptions).toHaveLength(3);
  });
  it.each(['2026-09-23T11:59:59.000Z', now])(
    'rejects expired diagnosis validity (%s)',
    (validUntil) => {
      const source = input();
      source.diagnosis = {
        ...source.diagnosis,
        provenance: { ...source.diagnosis.provenance, validUntil },
      };
      expect(evaluateShadow(source)).toMatchObject({
        eligibility: 'stale_evidence',
        simulation: { predictedOutcome: 'inconclusive' },
      });
    },
  );
  it.each([
    'revoked',
    'stale',
    'superseded',
    'revision',
    'clear',
    'unsupported',
  ] as const)('fails closed for %s evidence or capability', (reason) => {
    const source = input();
    if (reason === 'revoked') source.available = false;
    if (reason === 'stale') source.now = '2026-09-23T12:10:00.000Z';
    if (reason === 'superseded')
      source.diagnosis = { ...diagnosis, superseded: true };
    if (reason === 'revision') source.diagnosis = { ...diagnosis, revision: 2 };
    if (reason === 'clear')
      source.diagnosis = {
        ...diagnosis,
        detectorDecision: {
          ...diagnosis.detectorDecision,
          decision: 'clear',
          severity: null,
        },
      };
    if (reason === 'unsupported')
      source.candidate.action.capability = 'orders.cancel';
    const result = evaluateShadow(source);
    expect(result.simulation.predictedOutcome).toBe('inconclusive');
    expect(result.simulation.effects).toEqual({});
  });
  it('preserves the shipping capability risk floor when authored metadata is lower', () => {
    const source = input();
    source.candidate.action.risk = 'low';
    source.version.ir.action.minimumRisk = 'low';
    source.version.ir.approval.mode = 'policy';
    expect(evaluateShadow(source).policy?.outcome).toBe('approval_required');
  });
  it('denies the simulated action when the actor may not execute actions', () => {
    const source = { ...input(), access: new Set<string>(['actions.propose']) };
    expect(evaluateShadow(source)).toMatchObject({
      policy: { outcome: 'denied', reason: 'permission_denied' },
      simulation: { predictedOutcome: 'inconclusive' },
    });
  });
  it('keeps missing candidates visible', () => {
    expect(
      evaluateShadow({ ...input(), candidate: null, version: null }),
    ).toMatchObject({
      eligibility: 'no_candidate',
      candidate: null,
      policy: null,
    });
  });
  it('uses explicit denominators and does not count missing or incompatible outcomes', () => {
    const evaluation = evaluateShadow(input());
    const review = {
      actorId: 'reviewer',
      actionNeeded: true,
      eligible: true,
      operatorAction: candidate.action,
      evidenceRefs: ['evidence'],
      occurredAt: now,
      feedback: 'trust' as const,
    };
    const rows: ShadowComparison[] = [
      {
        evaluation,
        review,
        actual: {
          outcome: 'passed',
          evaluatorVersion: 'shipping-method/1',
          evidenceRefs: ['actual'],
          occurredAt: now,
        },
      },
      {
        evaluation: evaluateShadow({
          ...input(),
          candidate: null,
          version: null,
        }),
        review,
        actual: null,
      },
      {
        evaluation,
        review: { ...review, actionNeeded: false, feedback: 'distrust' },
        actual: {
          outcome: 'failed',
          evaluatorVersion: 'other/1',
          evidenceRefs: ['other'],
          occurredAt: now,
        },
      },
      { evaluation, review: null, actual: null },
    ];
    const metrics = shadowMetrics(rows, () => true);
    expect(metrics.falsePositiveActionRate).toEqual({
      numerator: 1,
      denominator: 2,
      rate: 0.5,
    });
    expect(metrics.missedEligibleCases).toEqual({
      numerator: 1,
      denominator: 2,
      rate: 0.5,
    });
    expect(metrics.predictedVsActualOutcome).toEqual({
      numerator: 1,
      denominator: 1,
      rate: 1,
    });
    expect(metrics.projectedAutonomousResolutionRate.numerator).toBe(0);
    expect(shadowMetrics([], () => true).operatorTrust.rate).toBeNull();
  });
});
