import type { TenantContext } from '@luma/identity';

import type { ProcessWorkflowVersion } from '../domain/process.js';
import type {
  ImprovementEvaluation,
  WorkflowControlComparison,
} from '../domain/workflow-improvement.js';

/** Composition supplies isolated production controls and durable recovery, never provider dispatch. */
export interface WorkflowImprovementControls {
  evaluate(
    context: TenantContext,
    baseline: ProcessWorkflowVersion,
    candidate: ProcessWorkflowVersion,
  ): Promise<WorkflowControlComparison>;
}

/** Clears technical coverage only for an exact trusted report with every mandatory check on both versions. */
export function applyControlComparison(
  report: ImprovementEvaluation,
  context: TenantContext,
  original: ProcessWorkflowVersion,
  compiled: ProcessWorkflowVersion,
) {
  const required = [
    'admission_success',
    'approval_rejected',
    'role_revoked',
    'foreign_tenant',
    'artifact_revoked',
    'principal_tamper',
    'idempotent_restart',
    'committed_temporal_restart',
  ];
  const controls = report.controls;
  if (!controls) return;
  const valid =
    controls.suiteVersion === 'workflow-control-simulator/1' &&
    controls.source === 'disposable_committed_fixture' &&
    controls.tenantId === context.tenantId &&
    controls.actorId === context.actor.id &&
    controls.baselineDigest === original.digest &&
    controls.candidateDigest === compiled.digest &&
    controls.passed &&
    controls.versions.length === 2 &&
    controls.versions.every((item, index) => {
      const version = index === 0 ? original : compiled;
      const actions = version.steps.filter(
        (step) => step.kind === 'capability',
      ).length;

      return (
        item.digest === version.digest &&
        item.actions === actions &&
        item.recovery === 'committed_postgres_temporal' &&
        required.every((id) =>
          item.checks.some(
            (check) =>
              check.id === id &&
              check.passed &&
              check.applicable ===
                (id === 'committed_temporal_restart' || actions > 0),
          ),
        )
      );
    });
  if (valid)
    report.missingCoverage = report.missingCoverage.filter(
      (item) =>
        item !== 'production_action_admission' &&
        item !== 'persisted_worker_restart',
    );
  else {
    report.passed = false;
    report.counterexamples.push('production_controls');
  }
}
