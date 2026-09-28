import type { ProcessStep, ProcessWorkflowVersion } from './process.js';

const names: Record<ProcessStep['kind'], string> = {
  code: 'Run TypeScript',
  read: 'Refresh context',
  condition: 'Check condition',
  capability: 'Use capability',
  approval: 'Get a decision',
  wait: 'Wait',
  verification: 'Verify result',
  escalation: 'Escalate',
  end: 'Finish',
};

/** Describes a native process without treating dispatch as verified success. */
export function presentProcessVersion(version: ProcessWorkflowVersion) {
  const actions = version.steps.filter((step) => step.kind === 'capability');
  const terminal = version.steps.at(-1);
  const capability =
    actions.length === 1
      ? actions[0]!.capability
      : `${actions.length} capability actions`;

  return {
    version: version.version,
    digest: version.digest,
    compatible: false,
    blockers: ['Actions are not yet available in this workspace.'],
    capability,
    capabilityVersion:
      actions.length === 1 ? actions[0]!.capabilityVersion : 'per step',
    targetKind: version.applicability.subjectKind,
    issueType: version.context.kind,
    systems: [] as string[],
    approval:
      'Each action needs an independent decision and Action Admission before dispatch.',
    permissions: [...new Set(actions.map((step) => step.capability))],
    provenance: version.provenance,
    finalOutcome: terminal?.kind === 'end' ? terminal.outcome : null,
    representation: JSON.stringify(version, null, 2),
    codeSteps: version.steps.filter((step) => step.kind === 'code'),
    steps: version.steps.map((step) => ({
      id: step.id,
      title: names[step.kind],
      description:
        step.kind === 'code'
          ? `Compute ${Object.keys(step.fields).join(', ') || 'a result'} with ${step.grants.length} granted capabilities.`
          : step.kind === 'capability'
            ? `${step.capability}@${step.capabilityVersion} on a ${step.targetKind}.`
            : step.kind === 'approval'
              ? `Decide whether ${step.forStep} may proceed.`
              : step.kind === 'verification'
                ? `Confirm the result of ${step.forStep}.`
                : step.kind === 'wait'
                  ? `Wait ${step.seconds} seconds before continuing.`
                  : step.kind === 'read'
                    ? `Read current ${step.source} context.`
                    : step.kind === 'condition'
                      ? `Continue when ${step.field} equals ${JSON.stringify(step.equals)}.`
                      : step.kind === 'escalation'
                        ? step.reason
                        : `Finish with ${step.outcome}.`,
      details:
        step.kind === 'capability'
          ? [
              `Minimum risk: ${step.minimumRisk}.`,
              'Current policy and grants are checked for this action.',
            ]
          : [],
    })),
  };
}
