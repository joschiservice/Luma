import type { CaseProgress } from '@luma/api-contract';

import { Badge } from '../primitives/badge';
import { caseLabel, CaseTime } from './case-investigation';

/** Describes the recorded execution outcome without implying unverified resolution. */
export function executionStatus(progress: CaseProgress) {
  const execution = progress.execution;
  const verification = execution?.verification;

  return progress.resolution
    ? progress.resolution.kind === 'verification'
      ? 'Resolution verified'
      : 'Closed by human disposition'
    : execution
      ? execution.state === 'unknown'
        ? 'Action outcome unknown'
        : execution.state === 'failed'
          ? 'Action failed'
          : verification?.outcome === 'passed'
            ? 'Outcome verified'
            : verification?.outcome === 'failed'
              ? 'Verification failed'
              : progress.state === 'verifying'
                ? 'Verifying outcome'
                : execution.state === 'succeeded'
                  ? 'Action succeeded'
                  : progress.state === 'executing'
                    ? 'Action running'
                    : 'Action reserved'
      : progress.state === 'awaiting_approval'
        ? 'Awaiting approval'
        : 'No execution recorded';
}

/** Shows recorded action and verification outcomes without implying that a successful action resolved the issue. */
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
        <p className="case-caption">Last confirmed status</p>
      ) : null}
      <h3>{tone ? <Badge tone={tone}>{status}</Badge> : status}</h3>
      {!execution ? (
        <p>
          {progress.state === 'awaiting_approval' && !progress.resolution
            ? 'Approval is required before an action can proceed. No execution attempt has been recorded.'
            : 'No execution attempt has been recorded for this issue.'}
        </p>
      ) : (
        <>
          <dl className="execution-result-rows">
            <div>
              <dt>Action</dt>
              <dd>
                <strong>
                  {
                    {
                      prepared: 'Result pending',
                      unknown: 'Outcome unknown',
                      succeeded: 'Succeeded',
                      failed: 'Failed',
                    }[execution.state]
                  }
                </strong>
                <span className="case-caption">
                  {execution.finishedAt ? 'Finished ' : 'Started '}
                  <CaseTime
                    value={execution.finishedAt ?? execution.startedAt}
                  />
                </span>
              </dd>
            </div>
            <div>
              <dt>Outcome verification</dt>
              <dd>
                <strong>
                  {verification
                    ? caseLabel(verification.outcome)
                    : progress.state === 'verifying'
                      ? 'Pending'
                      : 'Not recorded'}
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
            <p role="status">
              The action may have taken effect. Inspect fresh observations
              before taking further action.
            </p>
          ) : execution.state === 'failed' ? (
            <p>
              Inspect the attempt details and current findings before deciding
              what to do next.
            </p>
          ) : verification?.outcome === 'failed' ? (
            <p>
              The expected outcome was not confirmed. Review the verification
              evidence and current findings.
            </p>
          ) : !verification ? (
            <p className="case-caption">
              {progress.state === 'verifying'
                ? 'Waiting for observations to confirm the expected outcome.'
                : 'No verification result is recorded. A successful action alone does not establish resolution.'}
            </p>
          ) : verification.outcome !== 'passed' ? (
            <p className="case-caption">
              The intended outcome remains uncertain. Review the verification
              evidence.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

/** Keeps workflow state and revision identifiers available as secondary execution metadata. */
export function ExecutionMetadata({ progress }: { progress: CaseProgress }) {
  return (
    <dl>
      <dt>Case state</dt>
      <dd>{caseLabel(progress.state)}</dd>
      <dt>Case revision</dt>
      <dd>{progress.caseRevision}</dd>
      <dt>Investigation revision</dt>
      <dd>{progress.diagnosisRevision}</dd>
      <dt>Workflow</dt>
      <dd>
        {progress.workflow.availability === 'unavailable'
          ? 'Unavailable. Current activity is unknown.'
          : progress.workflow.availability === 'not_started'
            ? 'Not started'
            : progress.workflow.progress
              ? caseLabel(progress.workflow.progress.phase)
              : 'Current phase unknown'}
      </dd>
      {progress.workflow.progress?.reason ? (
        <>
          <dt>Workflow reason</dt>
          <dd>{caseLabel(progress.workflow.progress.reason)}</dd>
        </>
      ) : null}
    </dl>
  );
}
