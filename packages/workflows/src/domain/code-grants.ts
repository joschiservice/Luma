import type { ProcessStep, ProcessWorkflowVersion } from './process.js';

/** Returns nodes invoked only through a Code Step, including each action's verification. */
export function codeOwnedSteps(
  version: Pick<ProcessWorkflowVersion, 'steps'>,
): Set<string> {
  const ids = new Set(
    version.steps.flatMap((step) => (step.kind === 'code' ? step.grants : [])),
  );
  for (const step of version.steps) {
    if (step.kind === 'verification' && ids.has(step.forStep)) ids.add(step.id);
  }

  return ids;
}

/** The outer interpreter records code instructions; their granted nodes have a separate call journal. */
export function processInstructions(
  version: Pick<ProcessWorkflowVersion, 'steps'>,
): ProcessStep[] {
  const owned = codeOwnedSteps(version);

  return version.steps.filter((step) => !owned.has(step.id));
}
