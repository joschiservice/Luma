import { builtInMembership, makeTenantContext } from '@luma/identity';
import { expect, it } from 'vitest';

import { processVersion } from '../domain/process.fixture.js';
import type {
  ImprovementEvaluation,
  WorkflowControlComparison,
} from '../domain/workflow-improvement.js';
import { applyControlComparison } from './improvement-controls.js';

const context = makeTenantContext(
  { userId: 'operator', sessionId: 'session' },
  {
    id: 'tenant',
    name: 'Tenant',
    slug: 'tenant',
    dataRegion: 'EU',
    status: 'active',
  },
  builtInMembership(
    { id: 'member', organizationId: 'tenant', userId: 'operator' },
    'owner',
  ),
  'request',
);
const ids = [
  'admission_success',
  'approval_rejected',
  'role_revoked',
  'foreign_tenant',
  'artifact_revoked',
  'principal_tamper',
  'idempotent_restart',
  'committed_temporal_restart',
];

function report(): ImprovementEvaluation {
  const controls: WorkflowControlComparison = {
    suiteVersion: 'workflow-control-simulator/1',
    source: 'disposable_committed_fixture',
    tenantId: 'tenant',
    actorId: 'operator',
    baselineDigest: processVersion.digest,
    candidateDigest: processVersion.digest,
    passed: true,
    versions: [0, 1].map(() => ({
      digest: processVersion.digest,
      actions: 1,
      checks: ids.map((id) => ({ id, passed: true, applicable: true })),
      effects: 3,
      recovery: 'committed_postgres_temporal',
    })),
  };

  return {
    suiteVersion: 'workflow-improvement-safety/1',
    assertionVersion: 'workflow-improvement-invariants/1',
    fixtureHash: 'fixture',
    source: 'synthetic',
    passed: true,
    scenarios: [],
    counterexamples: [],
    missingCoverage: [
      'production_action_admission',
      'persisted_worker_restart',
      'historical_provider_reconstruction',
      'two_real_recurring_patterns',
    ],
    controls,
  };
}

it('accepts complete trusted committed-control coverage without claiming historical or real-pattern evidence', () => {
  const item = report();
  applyControlComparison(item, context, processVersion, processVersion);
  expect(item.passed).toBe(true);
  expect(item.missingCoverage).toEqual([
    'historical_provider_reconstruction',
    'two_real_recurring_patterns',
  ]);
});
it.each(['tenant', 'digest', 'missing', 'vacuous'] as const)(
  'rejects %s reports even when the producer declares success',
  (kind) => {
    const item = report();
    const controls = item.controls!;
    if (kind === 'tenant') controls.tenantId = 'foreign';
    if (kind === 'digest') controls.candidateDigest = 'another-version';
    if (kind === 'missing')
      controls.versions[0]!.checks = controls.versions[0]!.checks.filter(
        (check) => check.id !== 'committed_temporal_restart',
      );
    if (kind === 'vacuous') {
      controls.versions[0]!.actions = 0;
      controls.versions[0]!.checks.forEach((check) => {
        check.applicable = false;
      });
    }
    applyControlComparison(item, context, processVersion, processVersion);
    expect(item.passed).toBe(false);
    expect(item.counterexamples).toContain('production_controls');
    expect(item.missingCoverage).toContain('persisted_worker_restart');
  },
);
