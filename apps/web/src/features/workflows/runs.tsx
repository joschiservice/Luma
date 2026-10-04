import type { WorkflowDetail, WorkflowRunView } from '@luma/api-contract';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import { Card, CardHeader } from '@luma/ui/components/primitives/card';
import { Disclosure } from '@luma/ui/components/primitives/disclosure';
import {
  type OperationalState,
  StatePill,
} from '@luma/ui/components/primitives/state';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { Link, useLocation } from '@tanstack/react-router';
import type { ComponentType } from 'react';

import { CodeRunDetails } from './code-run';
import { workflowTriggerLabel } from './presentation';
import { CancelScheduledStart } from './triggers';

type ProcessState = NonNullable<WorkflowRunView['processState']>;

/** Operator labels for process states; only `verified` reads as a confirmed outcome. */
export const processStateLabels: Record<
  ProcessState,
  [string, OperationalState]
> = {
  running: ['Running', 'running'],
  awaiting_decision: ['Waiting for approval', 'approval'],
  waiting: ['Waiting', 'waiting'],
  verified: ['Verified', 'verified'],
  ended: ['Ended without acting', 'idle'],
  denied: ['Rejected', 'attention'],
  failed_verification: ['Verification failed', 'error'],
  inconclusive_verification: ['Couldn’t verify', 'attention'],
  escalated: ['Handed to a person', 'attention'],
};

function processStepDescription(
  step: NonNullable<WorkflowRunView['processSteps']>[number],
) {
  if (
    step.reason &&
    !['condition_not_met', 'policy_approval_required'].includes(step.reason)
  )
    return step.reason.replaceAll('_', ' ');

  switch (step.kind) {
    case 'code':
      return step.state === 'completed'
        ? 'The code returned its declared outputs.'
        : step.state === 'waiting'
          ? 'A requested capability needs approval.'
          : 'The code stopped. Review its execution details.';
    case 'read':
      return 'Current context refreshed.';
    case 'condition':
      return step.values.matched
        ? 'The observed conditions matched.'
        : 'The observed conditions did not match.';
    case 'approval':
      return step.state === 'waiting'
        ? 'Waiting for a decision.'
        : 'Decision recorded.';
    case 'capability':
      return step.state === 'waiting'
        ? 'Waiting for policy approval.'
        : step.state === 'completed'
          ? 'Action accepted. Verification is still required.'
          : 'The action did not proceed. Review the recorded reason.';
    case 'wait':
      return step.state === 'waiting'
        ? 'Waiting before the next step.'
        : 'Wait finished.';
    case 'verification':
      return step.state === 'completed'
        ? 'Expected result confirmed.'
        : step.state === 'failed'
          ? 'The result differs from the expected outcome.'
          : 'The result could not be confirmed.';
    case 'escalation':
      return 'This run needs attention.';
    case 'end':
      return typeof step.values.outcome === 'string'
        ? step.values.outcome
        : 'Process finished.';
  }
}

/** Lists recent runs with business step names, separating acceptance from verification. */
export function WorkflowRuns({
  detail,
  organizationId,
  runs,
  loading,
  error,
  refreshing,
  refetch,
  refresh,
  RunContext,
}: {
  detail: WorkflowDetail;
  organizationId: string;
  runs?: WorkflowRunView[] | undefined;
  loading: boolean;
  error?: string | undefined;
  refreshing: boolean;
  refetch: () => void;
  refresh: () => Promise<void>;
  RunContext?:
    ComponentType<{ organizationId: string; run: WorkflowRunView }> | undefined;
}) {
  const here = useLocation({ select: (location) => location.href });
  const definitionId = detail.summary.id;

  return (
    <Card
      as="section"
      className="workflow-section"
      aria-labelledby="runs-title"
    >
      <CardHeader className="workflows-heading">
        <h2 id="runs-title">Recent runs</h2>
        <Button variant="outline" disabled={refreshing} onClick={refetch}>
          Refresh runs
        </Button>
      </CardHeader>
      <p>
        {detail.versions.every((version) => version.format === 'workflow/2')
          ? 'Follow each decision, action and check through the run. An accepted action still needs verification.'
          : 'Execution acceptance and verified correction are separate results. Pilot, simulation and shadow evidence are not live verified success.'}
      </p>
      {error ? (
        <p role="alert">Run history is unavailable. {error}</p>
      ) : loading ? (
        <p role="status">Loading runs…</p>
      ) : !runs?.length ? (
        <p>No runs recorded for this workflow.</p>
      ) : (
        <div className="workflow-runs">
          {runs.map((run) => {
            const version = detail.versions.find(
              (item) => item.digest === run.versionDigest,
            );
            const stepTitle = (stepId: string) =>
              version?.steps.find((step) => step.id === stepId)?.title ??
              stepId.replaceAll(/[_-]/g, ' ');
            const [stateLabel, pill] = run.processState
              ? processStateLabels[run.processState]
              : ['', 'idle' as const];

            return (
              <article key={run.id} id={`run-${run.id}`} tabIndex={-1}>
                <div className="workflows-heading">
                  {run.resolution ? (
                    <Link
                      to="/app/$organizationId/exceptions/$exceptionId"
                      params={{
                        organizationId,
                        exceptionId: run.resolution.incidentId,
                      }}
                    >
                      Open issue
                    </Link>
                  ) : run.subject.kind === 'inventory_position' ? (
                    <Link
                      to="/app/$organizationId/inventory/$positionId"
                      params={{ organizationId, positionId: run.subject.id }}
                      search={{ from: here }}
                    >
                      Stock position
                    </Link>
                  ) : (
                    <span>{run.subject.kind.replaceAll('_', ' ')}</span>
                  )}
                  <time dateTime={run.createdAt}>
                    <WorkspaceDate value={run.createdAt} />
                  </time>
                </div>
                <p>
                  Version {run.version} ·{' '}
                  <strong>
                    {run.processSteps?.length
                      ? 'Process evidence'
                      : run.evidenceKind === 'pilot'
                        ? 'Pilot evidence'
                        : run.evidenceKind === 'unclassified'
                          ? 'Unclassified evidence — live success not established'
                          : `${run.evidenceKind} evidence`}
                  </strong>
                </p>
                <p className="workflow-run-trigger">
                  <strong>Triggered by: </strong>
                  {workflowTriggerLabel(run.trigger)}
                </p>
                {run.processState ? (
                  <div className="workflow-process-status" role="status">
                    <StatePill state={pill}>{stateLabel}</StatePill>
                    <span>{run.reason}</span>
                  </div>
                ) : null}
                {run.triggerState ? (
                  <Alert
                    tone={
                      run.triggerState === 'scheduled' ? 'neutral' : 'warning'
                    }
                  >
                    {run.reason}
                  </Alert>
                ) : null}
                {run.triggerState === 'scheduled' && detail.canManage ? (
                  <CancelScheduledStart
                    organizationId={organizationId}
                    definitionId={definitionId}
                    runId={run.id}
                    refresh={refresh}
                  />
                ) : null}
                {RunContext ? (
                  <RunContext organizationId={organizationId} run={run} />
                ) : null}
                <CodeRunDetails
                  run={run}
                  version={version}
                  organizationId={organizationId}
                  definitionId={definitionId}
                  canManage={detail.canManage}
                  refresh={refresh}
                />
                {run.processSteps?.length ? (
                  <ol
                    className="workflow-process-timeline"
                    aria-label="Step progress"
                  >
                    {run.processSteps.map((step) => (
                      <li key={`${step.stepId}:${step.state}`}>
                        <span
                          className={`workflow-process-dot workflow-process-dot--${step.state}`}
                          aria-hidden="true"
                        />
                        <div>
                          <div className="workflow-process-step-heading">
                            <strong>{stepTitle(step.stepId)}</strong>
                            <span>{step.state.replaceAll('_', ' ')}</span>
                            <WorkspaceDate value={step.recordedAt} />
                          </div>
                          <p>{processStepDescription(step)}</p>
                          {step.evidenceRefs.length ? (
                            <p>
                              {step.evidenceRefs.length} evidence{' '}
                              {step.evidenceRefs.length === 1
                                ? 'reference'
                                : 'references'}
                            </p>
                          ) : null}
                        </div>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <>
                    <dl className="workflow-run-story">
                      <div>
                        <dt>Investigation</dt>
                        <dd>{run.story.context}</dd>
                      </div>
                      <div>
                        <dt>Decision & human input</dt>
                        <dd>{run.story.decision}</dd>
                      </div>
                      <div>
                        <dt>Proposed action</dt>
                        <dd>{run.story.action}</dd>
                      </div>
                    </dl>
                    <dl>
                      <div>
                        <dt>Execution</dt>
                        <dd>{run.execution.replaceAll('_', ' ')}</dd>
                      </div>
                      <div>
                        <dt>Verification</dt>
                        <dd>{run.verification.replaceAll('_', ' ')}</dd>
                      </div>
                    </dl>
                    <p className="workflow-run-result">
                      {run.story.verification}
                    </p>
                  </>
                )}
                <Disclosure>
                  <summary>Run evidence references</summary>
                  <p>Run: {run.id}</p>
                  <p>Activation: {run.activationId ?? 'Not granted'}</p>
                  {run.triggerEvidence ? (
                    <p>
                      Source: {run.triggerEvidence.sourceId} ·{' '}
                      <WorkspaceDate value={run.triggerEvidence.occurredAt} />
                    </p>
                  ) : null}
                  <p>
                    Started by: {run.actor.kind} · {run.actor.id}
                  </p>
                  <p>
                    Subject: {run.subject.kind} · {run.subject.id}
                  </p>
                  <p>
                    Trigger:{' '}
                    {run.trigger.kind === 'exception'
                      ? run.trigger.issueType.replaceAll('_', ' ')
                      : run.trigger.kind}
                  </p>
                  <p>
                    Input snapshot: <code>{run.contextDigest}</code>
                  </p>
                  {run.steps.length ? (
                    <ol>
                      {run.steps.map((step, index) => (
                        <li key={`${step.stepId}:${index}`}>
                          {step.stepId} · {step.state.replaceAll('_', ' ')} ·{' '}
                          {step.reason.replaceAll('_', ' ')}
                        </li>
                      ))}
                    </ol>
                  ) : !run.processSteps?.length ? (
                    <p>No step outcome recorded.</p>
                  ) : null}
                  {run.processSteps?.length ? (
                    <ol>
                      {run.processSteps.map((step) => (
                        <li key={`${step.stepId}:${step.state}`}>
                          {step.stepId} · {step.kind} · {step.state}
                          {step.evidenceRefs.length
                            ? ` · ${step.evidenceRefs.join(', ')}`
                            : ''}
                        </li>
                      ))}
                    </ol>
                  ) : null}
                  <code>{run.versionDigest}</code>
                </Disclosure>
              </article>
            );
          })}
        </div>
      )}
    </Card>
  );
}
