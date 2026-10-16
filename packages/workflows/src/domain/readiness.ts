/**
 * Where an operator repairs a readiness issue. The web maps each destination to a route;
 * `server` has no product page because only whoever runs Luma can fix it.
 */
type ReadinessDestination =
  | 'connections'
  | 'suppliers'
  | 'inventory'
  | 'inventory_position'
  | 'purchase_order'
  | 'workflow_rules'
  | 'workflow_activity'
  | 'needs_you'
  | 'server';

/** A direct repair for an issue. `recordId` identifies the exact record or decision. */
export interface ReadinessRepair {
  label: string;
  destination: ReadinessDestination;
  recordId?: string;
}

/**
 * Something that stops the workflow (`blocking`) or stops part of its coverage (`degrading`).
 * `scope` names the affected record when the issue is not workflow-wide.
 */
export interface ReadinessIssue {
  code: string;
  severity: 'blocking' | 'degrading';
  message: string;
  scope: string | null;
  repair: ReadinessRepair | null;
}

/**
 * What the workflow currently covers. `covered` is null when coverage cannot be established,
 * which is different from covering nothing.
 */
export interface WorkflowCoverage {
  unit: string;
  covered: number | null;
  ready: number | null;
  explanation: string;
}

/** How approval actually applies under current policy, independent of quantity thresholds. */
export interface ApprovalBehavior {
  mode: 'every_action' | 'risk_based' | 'no_actions';
  summary: string;
  details: string[];
}

type OutcomeKind = 'verified' | 'unresolved' | 'in_progress' | 'ended';

/** Results of recent runs. Only an independent verification counts as verified. */
export interface OutcomeSummary {
  runs: number;
  verified: number;
  unresolved: number;
  inProgress: number;
  latest: {
    runId: string;
    state: OutcomeKind;
    at: string;
    summary: string;
  } | null;
  /** How the most recent runs ended, newest first, at most `recentOutcomeLimit`. */
  recent: { state: OutcomeKind; at: string }[];
}

/** Recent outcomes a summary lists one by one, enough to show a trend without run details. */
const recentOutcomeLimit = 10;

export interface WorkflowReadiness {
  /** Whether people turned the workflow on, separate from whether it can run. */
  enablement: 'enabled' | 'paused' | 'not_enabled';
  state: 'ready' | 'degraded' | 'blocked';
  issues: ReadinessIssue[];
  coverage: WorkflowCoverage;
  approval: ApprovalBehavior;
  /** Decisions waiting for a person. Null when this workflow can't report them. */
  waiting: { count: number | null; repair: ReadinessRepair | null };
  /** Null when this workflow has no run history Luma can classify. */
  outcomes: OutcomeSummary | null;
  nextAction: {
    label: string;
    description: string;
    repair: ReadinessRepair | null;
  };
}

/** Run states that end without the expected outcome being verified. */
const unresolvedStates = new Set([
  'failed_verification',
  'inconclusive_verification',
  'escalated',
  'denied',
]);

/**
 * Summarizes up to the given runs, newest first. A run that ended without acting (for example,
 * because stock was already covered) is neither verified nor unresolved.
 */
export function summarizeOutcomes(
  runs: { id: string; createdAt: string; state: string | undefined }[],
  describe: (state: string | undefined) => string,
): OutcomeSummary {
  const classify = (state: string | undefined) =>
    state === 'verified'
      ? ('verified' as const)
      : state && unresolvedStates.has(state)
        ? ('unresolved' as const)
        : state === 'ended' || state === 'not_executed'
          ? ('ended' as const)
          : ('in_progress' as const);
  const classified = runs.map((run) => ({ run, kind: classify(run.state) }));
  const latest = classified[0];

  return {
    runs: runs.length,
    verified: classified.filter((item) => item.kind === 'verified').length,
    unresolved: classified.filter((item) => item.kind === 'unresolved').length,
    inProgress: classified.filter((item) => item.kind === 'in_progress').length,
    latest: latest
      ? {
          runId: latest.run.id,
          state: latest.kind,
          at: latest.run.createdAt,
          summary: describe(latest.run.state),
        }
      : null,
    recent: classified
      .slice(0, recentOutcomeLimit)
      .map((item) => ({ state: item.kind, at: item.run.createdAt })),
  };
}

/**
 * Derives the readiness state and the single most useful next action. Blocking issues come first,
 * then waiting decisions, partial coverage, setup, and finally unresolved results. It never
 * reports ready while an issue blocks the workflow.
 */
export function assessReadiness(input: {
  enablement: WorkflowReadiness['enablement'];
  issues: ReadinessIssue[];
  coverage: WorkflowCoverage;
  approval: ApprovalBehavior;
  waiting: WorkflowReadiness['waiting'];
  outcomes: OutcomeSummary | null;
  /** The action that turns this workflow on, such as adding a stock rule. */
  enable: ReadinessRepair | null;
  /** Describes ongoing work when nothing needs a person. */
  idle: string;
}): WorkflowReadiness {
  const blocking = input.issues.filter((i) => i.severity === 'blocking');
  const degrading = input.issues.filter((i) => i.severity === 'degrading');
  const state = blocking.length
    ? 'blocked'
    : degrading.length
      ? 'degraded'
      : 'ready';
  const fromIssue = (issue: ReadinessIssue) => ({
    label: issue.repair?.label ?? 'Review the requirement',
    description: issue.scope
      ? `${issue.scope}: ${issue.message}`
      : issue.message,
    repair: issue.repair,
  });
  const waiting = input.waiting.count ?? 0;
  const unresolved = input.outcomes?.latest?.state === 'unresolved';

  const nextAction = blocking[0]
    ? fromIssue(blocking[0])
    : waiting > 0
      ? {
          label: `Review ${waiting} waiting ${waiting === 1 ? 'decision' : 'decisions'}`,
          description:
            'Proposals wait for a person before Luma acts. They expire when their evidence gets old.',
          repair: input.waiting.repair,
        }
      : degrading[0]
        ? fromIssue(degrading[0])
        : input.enablement === 'not_enabled'
          ? {
              label: input.enable?.label ?? 'Set up this workflow',
              description:
                'Nothing runs until someone reviews the exact scope and turns it on.',
              repair: input.enable,
            }
          : input.enablement === 'paused'
            ? {
                label: input.enable?.label ?? 'Set up this workflow again',
                description:
                  'Every activation was revoked, so no new runs start. Earlier history stays available.',
                repair: input.enable,
              }
            : unresolved
              ? {
                  label: 'Review the latest run',
                  description: `${input.outcomes!.latest!.summary} A person needs to check what happened.`,
                  repair: {
                    label: 'Review the latest run',
                    destination: 'workflow_activity' as const,
                    recordId: input.outcomes!.latest!.runId,
                  },
                }
              : {
                  label: 'Nothing needed',
                  description: input.idle,
                  repair: null,
                };

  return {
    enablement: input.enablement,
    state,
    issues: input.issues,
    coverage: input.coverage,
    approval: input.approval,
    waiting: input.waiting,
    outcomes: input.outcomes,
    nextAction,
  };
}

/** Writes an effective approval rule in operator language from the policy requirement. */
export function describeApproval(
  requirement: {
    mode: 'every_action' | 'risk_based';
    reason: 'minimum_risk' | 'workspace_policy' | 'workflow' | 'risk';
  },
  action: string,
): ApprovalBehavior {
  if (requirement.mode === 'risk_based')
    return {
      mode: 'risk_based',
      summary: `Low-risk ${action} can run without a person. Anything riskier waits for someone else who can approve changes.`,
      details: [
        'Luma classifies each proposal when it is made. Approval is checked again just before Luma acts.',
        'Turn on “Always require approval” in Settings to make every action wait for a person.',
      ],
    };

  return {
    mode: 'every_action',
    summary: `Someone else who can approve changes approves every ${action} before Luma acts.`,
    details: [
      requirement.reason === 'workspace_policy'
        ? 'Workspace settings require approval for every action.'
        : requirement.reason === 'workflow'
          ? 'This workflow version requires approval for every action.'
          : 'This action is medium risk or higher, so workspace policy always requires approval.',
      'The person who started a run can’t approve it. Approval doesn’t extend expired evidence.',
    ],
  };
}
