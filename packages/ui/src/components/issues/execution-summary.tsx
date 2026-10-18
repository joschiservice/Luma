import type { CaseProgress } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { rich } from '@luma/i18n/rich';

import { Badge } from '../primitives/badge';
import { caseLabel, CaseTime } from './case-investigation';
import {
  caseStateLabel,
  executionStateLabel,
  verificationLabel,
  workflowStatusLabel,
} from './case-presentation';

/**
 * Describes where the change stands without implying unverified resolution: sent, accepted and
 * confirmed stay distinct.
 */
export function executionStatus(progress: CaseProgress) {
  const execution = progress.execution;
  const verification = execution?.verification;

  return progress.resolution
    ? progress.resolution.kind === 'verification'
      ? m.issues_resolution_verified_title()
      : m.issues_execution_status_closed_unconfirmed()
    : execution
      ? execution.state === 'unknown'
        ? m.issues_execution_status_unclear()
        : execution.state === 'failed'
          ? m.issues_state_failed()
          : verification?.outcome === 'passed'
            ? m.issues_execution_status_confirmed()
            : verification?.outcome === 'failed'
              ? m.issues_execution_status_not_confirmed()
              : progress.state === 'verifying'
                ? m.issues_state_verifying()
                : execution.state === 'succeeded'
                  ? m.issues_execution_status_accepted()
                  : progress.state === 'executing'
                    ? m.issues_state_executing()
                    : m.issues_execution_status_queued()
      : progress.state === 'awaiting_approval'
        ? m.issues_execution_status_awaiting_approval()
        : m.issues_execution_status_none();
}

/** Shows the sent change and its outcome check without implying that an accepted change resolved the issue. */
export function ExecutionSummary({
  progress,
  confirmed,
}: {
  progress: CaseProgress;
  confirmed: boolean;
}) {
  const execution = progress.execution;
  const verification = execution?.verification;
  const status = executionStatus(progress);

  const tone = !confirmed
    ? undefined
    : progress.resolution
      ? progress.resolution.kind === 'verification'
        ? 'success'
        : undefined
      : execution?.state === 'failed' || verification?.outcome === 'failed'
        ? 'danger'
        : execution?.state === 'unknown' ||
            progress.state === 'awaiting_approval'
          ? 'warning'
          : verification?.outcome === 'passed'
            ? 'success'
            : execution
              ? 'info'
              : undefined;

  return (
    <div className="execution-summary">
      {!confirmed ? (
        <p className="case-caption">{m.issues_execution_last_confirmed()}</p>
      ) : null}
      <h3>{tone ? <Badge tone={tone}>{status}</Badge> : status}</h3>
      {!execution ? (
        <p>
          {progress.state === 'awaiting_approval' && !progress.resolution
            ? m.issues_execution_none_awaiting_approval()
            : progress.resolution
              ? m.issues_execution_no_record()
              : m.issues_execution_none()}
        </p>
      ) : (
        <>
          <dl className="execution-result-rows">
            <div>
              <dt>{m.issues_execution_change_label()}</dt>
              <dd>
                <strong>{executionStateLabel(execution.state)}</strong>
                <span className="case-caption">
                  {rich(
                    execution.finishedAt
                      ? m.issues_execution_finished_at
                      : m.issues_execution_started_at,
                    {
                      time: (
                        <CaseTime
                          value={execution.finishedAt ?? execution.startedAt}
                        />
                      ),
                    },
                  )}
                </span>
              </dd>
            </div>
            <div>
              <dt>{m.issues_check_label()}</dt>
              <dd>
                <strong>
                  {verification
                    ? verificationLabel(verification.outcome)
                    : progress.state === 'verifying'
                      ? m.issues_check_running()
                      : m.issues_check_none()}
                </strong>
                {verification ? (
                  <span className="case-caption">
                    <CaseTime value={verification.observedAt} />
                  </span>
                ) : null}
              </dd>
            </div>
          </dl>
          {execution.state === 'unknown' ? (
            <p role="status">{m.issues_execution_unclear_help()}</p>
          ) : execution.state === 'failed' ? (
            <p>{m.issues_execution_failed_help()}</p>
          ) : verification?.outcome === 'failed' ? (
            <p>{m.issues_check_failed_help()}</p>
          ) : !verification ? (
            <p className="case-caption">
              {progress.state === 'verifying'
                ? m.issues_check_running_help()
                : m.issues_check_none_help()}
            </p>
          ) : verification.outcome !== 'passed' ? (
            <p className="case-caption">{m.issues_check_unclear_help()}</p>
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * Keeps workflow state and the issue version available as secondary change metadata. The
 * investigation version is shown once, in the issue's technical details.
 */
export function ExecutionMetadata({ progress }: { progress: CaseProgress }) {
  return (
    <dl>
      <dt>{m.issues_meta_issue_state()}</dt>
      <dd>{caseStateLabel(progress.state)}</dd>
      <dt>{m.issues_meta_issue_version()}</dt>
      <dd>{progress.caseRevision}</dd>
      <dt>{m.issues_meta_workflow()}</dt>
      <dd>
        {progress.workflowRuns?.length
          ? m.issues_workflow_recorded_status()
          : workflowStatusLabel(progress.workflow)}
      </dd>
      {progress.workflow.progress?.reason ? (
        <>
          <dt>{m.issues_meta_workflow_reason()}</dt>
          <dd>{caseLabel(progress.workflow.progress.reason)}</dd>
        </>
      ) : null}
    </dl>
  );
}
