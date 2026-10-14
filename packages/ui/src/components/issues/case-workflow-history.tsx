import type { CaseProgress } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import type { ReactNode } from 'react';

import { personLabel } from '../../lib/actor';
import { Disclosure } from '../primitives/disclosure';
import { WorkspaceDate } from '../primitives/workspace-date';
import { ActionDiff } from './action-diff';
import { executionStateLabel, verificationLabel } from './case-presentation';

type Run = NonNullable<CaseProgress['workflowRuns']>[number];

const stepStates: Record<string, () => string> = {
  completed: m.workflows_step_state_completed,
  waiting: m.workflows_step_state_waiting,
  denied: m.workflows_step_state_denied,
  failed: m.workflows_step_state_failed,
  inconclusive: m.workflows_step_state_inconclusive,
  ended: m.workflows_step_state_ended,
  escalated: m.workflows_step_state_escalated,
};

function stepLabel(value: string) {
  return value.replaceAll(/[_-]/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

/** Shows owner-recorded workflow work and evidence without granting case decisions over it. */
export function CaseWorkflowHistory({
  progress,
  link,
}: {
  progress: CaseProgress;
  link?: ((run: Run) => ReactNode) | undefined;
}) {
  if (!progress.workflowRuns?.length) return null;

  return (
    <section aria-label={m.issues_workflow_history()}>
      <h3>{m.issues_workflow_history()}</h3>
      {progress.workflowRuns.map((run) => (
        <div key={run.id}>
          <h4>
            {link ? link(run) : run.name} · {run.version}
          </h4>
          {run.actions.map((action) => (
            <div key={action.proposalId}>
              {action.diff ? (
                <ActionDiff diff={action.diff} />
              ) : (
                <p>{action.capability}</p>
              )}
              {action.approval ? (
                <p>
                  {action.approval.outcome === 'approved'
                    ? m.issues_workflow_approved({
                        actor: personLabel(
                          progress.people,
                          action.approval.actorId,
                        ),
                      })
                    : m.issues_workflow_rejected({
                        actor: personLabel(
                          progress.people,
                          action.approval.actorId,
                        ),
                      })}{' '}
                  · <WorkspaceDate value={action.approval.createdAt} />
                </p>
              ) : null}
              {action.execution ? (
                <p>
                  {executionStateLabel(action.execution.state)} ·{' '}
                  <WorkspaceDate
                    value={
                      action.execution.finishedAt ?? action.execution.startedAt
                    }
                  />
                  {action.execution.verification ? (
                    <>
                      {' '}
                      ·{' '}
                      {verificationLabel(
                        action.execution.verification.outcome,
                      )}{' '}
                      ·{' '}
                      <WorkspaceDate
                        value={action.execution.verification.observedAt}
                      />
                    </>
                  ) : null}
                </p>
              ) : (
                <p>{m.issues_workflow_no_dispatch()}</p>
              )}
            </div>
          ))}
          <Disclosure>
            <summary>{m.issues_workflow_steps()}</summary>
            <ol>
              {run.steps.map((step) => (
                <li key={`${step.stepId}:${step.state}`}>
                  <p>
                    {stepLabel(step.stepId)} ·{' '}
                    {stepStates[step.state]?.() ?? stepLabel(step.state)} ·{' '}
                    <WorkspaceDate value={step.recordedAt} />
                  </p>
                  {step.kind === 'verification' ? (
                    <p>
                      {m.issues_workflow_verification_read()}{' '}
                      {step.observedAt ? (
                        <WorkspaceDate value={step.observedAt} />
                      ) : null}
                    </p>
                  ) : null}
                  {step.evidenceRefs.length ? (
                    <ul>
                      {step.evidenceRefs.map((ref) => (
                        <li key={ref}>
                          <code>{ref}</code>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ol>
          </Disclosure>
          {run.truncated ? (
            <p>{m.issues_workflow_history_truncated()}</p>
          ) : null}
        </div>
      ))}
      {progress.workflowRunsTruncated ? (
        <p>{m.issues_workflow_history_truncated()}</p>
      ) : null}
    </section>
  );
}
