import { describe, expect, it } from 'vitest';

import { draftFromVersion } from './draft.js';
import { processVersion } from './process.fixture.js';
import {
  improvementDiagnostics,
  improvementReview,
} from './workflow-improvement.js';

describe('workflow improvement authority', () => {
  const baseline = draftFromVersion(processVersion);

  it('retains approvals and independent verification, rejects widening and executable source', () => {
    const candidate = structuredClone(baseline);
    candidate.steps = candidate.steps.filter(
      (step) => step.kind !== 'approval',
    );
    candidate.context.maxAgeSeconds += 1;
    candidate.applicability.trigger = {
      kind: 'event',
      eventType: 'all-orders',
    };
    candidate.steps.splice(1, 0, {
      id: 'more-access',
      kind: 'read',
      source: 'foreign-orders',
      fields: {},
    });
    candidate.steps.splice(1, 0, {
      id: 'untrusted',
      kind: 'code',
      source: 'function main(){return {}}',
      fields: {},
      grants: [],
      limits: { fuel: 100, memoryBytes: 1024, wallTimeMs: 1, maxRequests: 0 },
    });
    expect(
      improvementDiagnostics(baseline, candidate).map((item) => item.field),
    ).toEqual(
      expect.arrayContaining(['applicability', 'context', 'source', 'steps']),
    );
    expect(improvementDiagnostics(baseline, baseline)).toEqual([]);
  });

  it('reports honest coverage, exact hashes, required actions and separately reviewed scope', () => {
    const evidence = {
      incidentId: 'case',
      runId: 'run',
      pattern: 'inventory_mismatch' as const,
      subjectId: 'stock',
      evidenceRefs: ['read'],
      evaluatorVersion: 'v1',
      verifiedAt: '2026-01-01T00:00:00.000Z',
      artifactDigest: 'a',
      repairCodes: ['correct-stock'],
      humanInterventions: 1,
    };
    const review = improvementReview(
      evidence,
      'baseline',
      baseline,
      'candidate',
    );
    expect(review.rollout.subjectIds).toEqual(['stock']);
    expect(review.requiredCapabilities).toEqual(['stock.reserve@1']);
    expect(review.humanSteps).toEqual(['review']);
    expect(review.coverage).toBe('not_evaluated');
    expect(review.missingCoverage).toContain('two_real_recurring_patterns');
  });
});

it('preserves required verification when validated property ordering changes', () => {
  const baseline = draftFromVersion(processVersion);
  const candidate = structuredClone(baseline);
  candidate.steps = candidate.steps.map((step) =>
    step.kind === 'verification'
      ? {
          fields: step.fields,
          id: step.id,
          kind: step.kind,
          forStep: step.forStep,
          evaluatorVersion: step.evaluatorVersion,
          maxDurationSeconds: step.maxDurationSeconds,
          ...(step.recheck ? { recheck: step.recheck } : {}),
        }
      : step,
  );
  expect(improvementDiagnostics(baseline, candidate)).toEqual([]);
});

it('refuses weakening the reviewed postcondition even when the verification step is unchanged', () => {
  const baseline = draftFromVersion(processVersion);
  const candidate = structuredClone(baseline);
  const action = candidate.steps.find((step) => step.kind === 'capability');
  if (action?.kind !== 'capability') throw new Error('Missing action fixture');
  action.expectedPostcondition = {};
  expect(improvementDiagnostics(baseline, candidate)).toContainEqual(
    expect.objectContaining({ severity: 'error', stepId: action.id }),
  );
});
