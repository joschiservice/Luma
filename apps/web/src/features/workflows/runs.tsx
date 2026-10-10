import type {
  ActivityActor,
  WorkflowDetail,
  WorkflowRunView,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { rich } from '@luma/i18n/rich';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Card, CardHeader } from '@luma/ui/components/primitives/card';
import { Disclosure } from '@luma/ui/components/primitives/disclosure';
import { RefreshButton } from '@luma/ui/components/primitives/refresh-button';
import {
  type OperationalState,
  StatePill,
} from '@luma/ui/components/primitives/state';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { personLabel } from '@luma/ui/lib/actor';
import { Link, useLocation } from '@tanstack/react-router';
import type { ComponentType } from 'react';

import { CodeRunDetails } from './code-run';
import { workflowTriggerLabel } from './presentation';
import { CancelScheduledStart } from './triggers';

type ProcessState = NonNullable<WorkflowRunView['processState']>;

type ProcessStep = NonNullable<WorkflowRunView['processSteps']>[number];

/** Labels for run states; only `verified` reads as a confirmed outcome. */
const processStateLabels: Record<
  ProcessState,
  [() => string, OperationalState]
> = {
  running: [m.workflows_run_state_running, 'running'],
  awaiting_decision: [m.workflows_run_state_awaiting_decision, 'approval'],
  waiting: [m.workflows_run_state_waiting, 'waiting'],
  verified: [m.workflows_run_state_verified, 'verified'],
  ended: [m.workflows_run_state_ended, 'idle'],
  denied: [m.workflows_run_state_denied, 'attention'],
  failed_verification: [m.workflows_run_state_failed_verification, 'error'],
  inconclusive_verification: [
    m.workflows_run_state_inconclusive_verification,
    'attention',
  ],
  escalated: [m.workflows_run_state_escalated, 'attention'],
};

const stepStateLabels = {
  completed: m.workflows_step_state_completed,
  waiting: m.workflows_step_state_waiting,
  denied: m.workflows_step_state_denied,
  failed: m.workflows_step_state_failed,
  inconclusive: m.workflows_step_state_inconclusive,
  ended: m.workflows_step_state_ended,
  escalated: m.workflows_step_state_escalated,
} satisfies Record<ProcessStep['state'], () => string>;

const evidenceLabels = {
  pilot: m.workflows_runs_source_pilot,
  live: m.workflows_runs_source_live,
  simulation: m.workflows_runs_source_simulation,
  shadow: m.workflows_runs_source_shadow,
  unclassified: m.workflows_runs_source_unclassified,
} satisfies Record<WorkflowRunView['evidenceKind'], () => string>;

function processStepDescription(step: ProcessStep) {
  if (
    step.reason &&
    !['condition_not_met', 'policy_approval_required'].includes(step.reason)
  )
    return step.reason.replaceAll('_', ' ');

  switch (step.kind) {
    case 'code':
      return step.state === 'completed'
        ? m.workflows_step_code_completed()
        : step.state === 'waiting'
          ? m.workflows_step_code_waiting()
          : m.workflows_step_code_stopped();
    case 'read':
      return m.workflows_step_read();
    case 'condition':
      return step.values.matched
        ? m.workflows_step_condition_matched()
        : m.workflows_step_condition_not_matched();
    case 'approval':
      return step.state === 'waiting'
        ? m.workflows_step_approval_waiting()
        : m.workflows_step_approval_done();
    case 'capability':
      return step.state === 'waiting'
        ? m.workflows_step_change_waiting()
        : step.state === 'completed'
          ? m.workflows_step_change_accepted()
          : m.workflows_step_change_stopped();
    case 'wait':
      return step.state === 'waiting'
        ? m.workflows_step_wait_waiting()
        : m.workflows_step_wait_done();
    case 'verification':
      return step.state === 'completed'
        ? m.workflows_step_verify_confirmed()
        : step.state === 'failed'
          ? m.workflows_step_verify_failed()
          : m.workflows_step_verify_unclear();
    case 'escalation':
      return m.workflows_step_escalation();
    case 'end':
      return typeof step.values.outcome === 'string'
        ? step.values.outcome
        : m.workflows_step_end();
  }
}

/** Lists recent runs with business step names, separating acceptance from verification. */
export function WorkflowRuns({
  detail,
  organizationId,
  runs,
  people,
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
  /** The people who started the runs, or who an agent started them for. */
  people: readonly ActivityActor[];
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
        <h2 id="runs-title">{m.workflows_runs_title()}</h2>
        <RefreshButton
          label={m.workflows_runs_refresh()}
          refreshing={refreshing}
          onClick={refetch}
        />
      </CardHeader>
      <p>
        {detail.versions.every((version) => version.format === 'workflow/2')
          ? m.workflows_runs_description_process()
          : m.workflows_runs_description_legacy()}
      </p>
      {error ? (
        <p role="alert">{m.workflows_runs_error({ error })}</p>
      ) : loading ? (
        <p role="status">{m.workflows_runs_loading()}</p>
      ) : !runs?.length ? (
        <p>{m.workflows_runs_empty()}</p>
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
              : [() => '', 'idle' as const];

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
                      {m.workflows_runs_open_issue()}
                    </Link>
                  ) : run.subject.kind === 'inventory_position' ? (
                    <Link
                      to="/app/$organizationId/inventory/$positionId"
                      params={{ organizationId, positionId: run.subject.id }}
                      search={{ from: here }}
                    >
                      {m.workflows_runs_stock_position()}
                    </Link>
                  ) : (
                    <span>{run.subject.kind.replaceAll('_', ' ')}</span>
                  )}
                  <time dateTime={run.createdAt}>
                    <WorkspaceDate value={run.createdAt} />
                  </time>
                </div>
                <p>
                  {rich(m.workflows_runs_version_source, {
                    version: run.version,
                    source: (
                      <strong>
                        {run.processSteps?.length
                          ? m.workflows_runs_source_process()
                          : evidenceLabels[run.evidenceKind]()}
                      </strong>
                    ),
                  })}
                </p>
                <p className="workflow-run-trigger">
                  <strong>{m.workflows_runs_triggered_by()} </strong>
                  {workflowTriggerLabel(run.trigger)}
                </p>
                {run.processState ? (
                  <div className="workflow-process-status" role="status">
                    <StatePill state={pill}>{stateLabel()}</StatePill>
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
                    aria-label={m.workflows_runs_steps_label()}
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
                            <span>{stepStateLabels[step.state]()}</span>
                            <WorkspaceDate value={step.recordedAt} />
                          </div>
                          <p>{processStepDescription(step)}</p>
                          {step.evidenceRefs.length ? (
                            <p>
                              {m.workflows_runs_evidence_count({
                                count: step.evidenceRefs.length,
                              })}
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
                        <dt>{m.workflows_runs_story_context()}</dt>
                        <dd>{run.story.context}</dd>
                      </div>
                      <div>
                        <dt>{m.workflows_runs_story_decision()}</dt>
                        <dd>{run.story.decision}</dd>
                      </div>
                      <div>
                        <dt>{m.workflows_runs_story_action()}</dt>
                        <dd>{run.story.action}</dd>
                      </div>
                    </dl>
                    <dl>
                      <div>
                        <dt>{m.workflows_runs_change_status()}</dt>
                        <dd>{run.execution.replaceAll('_', ' ')}</dd>
                      </div>
                      <div>
                        <dt>{m.workflows_runs_check_status()}</dt>
                        <dd>{run.verification.replaceAll('_', ' ')}</dd>
                      </div>
                    </dl>
                    <p className="workflow-run-result">
                      {run.story.verification}
                    </p>
                  </>
                )}
                <Disclosure>
                  <summary>{m.workflows_runs_details()}</summary>
                  <p>{m.workflows_runs_id({ id: run.id })}</p>
                  <p>
                    {run.activationId
                      ? m.workflows_runs_activation({ id: run.activationId })
                      : m.workflows_runs_activation_none()}
                  </p>
                  {run.triggerEvidence ? (
                    <p>
                      {rich(m.workflows_runs_source, {
                        source: run.triggerEvidence.sourceId,
                        date: (
                          <WorkspaceDate
                            value={run.triggerEvidence.occurredAt}
                          />
                        ),
                      })}
                    </p>
                  ) : null}
                  <p>
                    {run.actor.kind === 'agent'
                      ? m.workflows_runs_started_by_agent({
                          agent: run.actor.id,
                          person: personLabel(people, run.actor.operatorId),
                        })
                      : m.workflows_runs_started_by({
                          actor: personLabel(people, run.actor.id),
                        })}
                  </p>
                  <p>
                    {m.workflows_runs_record({
                      kind: run.subject.kind,
                      id: run.subject.id,
                    })}
                  </p>
                  <p>
                    {m.workflows_runs_trigger({
                      trigger:
                        run.trigger.kind === 'exception'
                          ? run.trigger.issueType.replaceAll('_', ' ')
                          : run.trigger.kind,
                    })}
                  </p>
                  <p>
                    {m.workflows_runs_input_fingerprint()}{' '}
                    <code>{run.contextDigest}</code>
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
                    <p>{m.workflows_runs_no_steps()}</p>
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
