import { useId, useState } from 'react';
import type {
  CaseDecision,
  CaseProgress,
  CaseReview,
} from '@luma/api-contract';
import { Button } from './button';
import { CaseNotice, CaseTime, caseLabel } from './case-investigation';

type DecisionKind = CaseDecision['kind'];
function fieldLabel(value: string) {
  return caseLabel(
    value.replaceAll('.', ' ').replace(/([a-z])([A-Z])/g, '$1 $2'),
  );
}
export function ResolutionReview({
  review,
  progress,
  connectionLabel,
  disabled = false,
  pending = false,
  refreshing = false,
  onDecision,
}: {
  review: CaseReview;
  progress?: CaseProgress;
  connectionLabel?: string | undefined;
  disabled?: boolean;
  pending?: boolean;
  refreshing?: boolean;
  onDecision: (kind: DecisionKind, reason: string) => void;
}) {
  const proposal = review.proposal;
  return (
    <article
      className="case-investigation resolution-review"
      aria-label="Resolution review"
    >
      <section>
        <h3>
          <span>06</span> Review the resolution
        </h3>
        {proposal ? (
          <>
            <h4>{fieldLabel(proposal.capability)}</h4>
            <p className="case-caption">
              Proposal version {proposal.version} · Investigation revision{' '}
              {proposal.diagnosisRevision}
            </p>
            <dl className="resolution-facts">
              <dt>Target system</dt>
              <dd>{connectionLabel ?? proposal.connectionId}</dd>
              <dt>Target object</dt>
              <dd>
                {caseLabel(proposal.target.kind)} · {proposal.target.id}
              </dd>
              <dt>Risk</dt>
              <dd>{caseLabel(proposal.risk)}</dd>
              <dt>Available recovery</dt>
              <dd>
                No recovery action is specified for this proposal. Do not assume
                the change can be undone.
              </dd>
            </dl>
            <h4>Proposed changes</h4>
            <Fields values={proposal.parameters} />
            <h4>Expected result</h4>
            <Fields values={proposal.expectedPostcondition} />
            <h4>Preconditions</h4>
            <p>
              Evidence must remain current through{' '}
              <CaseTime value={proposal.preconditions.validUntil} />.
            </p>
            <ul>
              {proposal.preconditions.evidenceRefs.map((ref) => (
                <li key={ref}>{ref}</li>
              ))}
            </ul>
            <p className="case-caption">
              Proposal expires <CaseTime value={proposal.expiresAt} />.
            </p>
            <CaseNotice
              title={
                proposal.policy?.outcome === 'allowed'
                  ? 'Automatic execution allowed'
                  : proposal.policy?.outcome === 'denied'
                    ? 'Action prohibited by policy'
                    : proposal.policy?.outcome === 'approval_required'
                      ? 'Human approval required'
                      : 'Policy result unavailable'
              }
            >
              {proposal.policy?.reason ??
                'Execution is not authorized without a current policy result.'}
              {proposal.policy?.outcome === 'allowed'
                ? ' No approval click is needed. Execution and verification are tracked below.'
                : null}
            </CaseNotice>
            {!proposal.available ? (
              <CaseNotice title="Action unavailable">
                The target capability cannot currently execute this proposal.
              </CaseNotice>
            ) : null}
            {proposal.diagnosisRevision !== review.diagnosisRevision ? (
              <CaseNotice title="Proposal is out of date">
                The investigation changed. Wait for a current proposal.
              </CaseNotice>
            ) : null}
            {proposal.approval ? (
              <CaseNotice
                title={
                  proposal.approval.outcome === 'approved'
                    ? 'Approval recorded'
                    : 'Proposal rejected'
                }
              >
                {proposal.approval.outcome === 'approved'
                  ? 'The decision is recorded. Execution and verification are tracked separately below.'
                  : 'This proposal has not been approved for execution.'}
              </CaseNotice>
            ) : null}
          </>
        ) : (
          <p>
            No resolution proposal is available. Review the investigation for
            manual next steps.
          </p>
        )}
        {/* Routine policy reevaluations change IDs, not the decision being drafted. */}
        <DecisionControls
          key={JSON.stringify([
            review.diagnosisRevision,
            proposal?.id,
            proposal?.version,
            proposal?.available,
            proposal?.policy?.policyVersion,
            proposal?.policy?.outcome,
            proposal?.policy?.reason,
            [...review.permittedDecisions].sort(),
          ])}
          decisions={review.permittedDecisions}
          disabled={disabled}
          pending={pending}
          refreshing={refreshing}
          onDecision={onDecision}
        />
      </section>
      <section aria-label="Execution and verification">
        <h3>
          <span>07</span> Execution and verification
        </h3>
        {progress ? (
          <>
            <p>Case: {caseLabel(progress.state)}</p>
            <p>
              Execution:{' '}
              {progress.execution
                ? caseLabel(progress.execution.state)
                : 'Not recorded'}
            </p>
            <p>
              Verification:{' '}
              {progress.execution?.verification
                ? caseLabel(progress.execution.verification.outcome)
                : 'Not recorded'}
            </p>
            {progress.execution?.verification ? (
              <p className="case-caption">
                Observed{' '}
                <CaseTime value={progress.execution.verification.observedAt} />{' '}
                · Evidence:{' '}
                {progress.execution.verification.observationRefs.join(', ') ||
                  'None recorded'}
              </p>
            ) : null}
            {progress.workflow.availability === 'unavailable' ? (
              <CaseNotice title="Workflow progress unavailable">
                Execution status is uncertain. Refresh to check current
                progress.
              </CaseNotice>
            ) : progress.workflow.progress ? (
              <p>Workflow: {caseLabel(progress.workflow.progress.phase)}</p>
            ) : null}
            {progress.resolution ? (
              <CaseNotice
                title={
                  progress.resolution.kind === 'verification'
                    ? 'Resolution verified'
                    : 'Closed by human disposition'
                }
              >
                {progress.resolution.kind === 'verification'
                  ? 'Fresh evidence confirms the correction.'
                  : 'Closure does not establish a verified correction.'}
              </CaseNotice>
            ) : (
              <p className="case-caption">
                A recorded decision does not establish a successful correction.
              </p>
            )}
          </>
        ) : (
          <p>Current execution and verification status is unavailable.</p>
        )}
      </section>
    </article>
  );
}
function Fields({
  values,
}: {
  values: Record<string, string | number | boolean | null>;
}) {
  return Object.keys(values).length ? (
    <dl className="resolution-facts">
      {Object.entries(values).map(([key, value]) => (
        <div key={key}>
          <dt>{fieldLabel(key)}</dt>
          <dd>{value === null ? 'Not specified' : String(value)}</dd>
        </div>
      ))}
    </dl>
  ) : (
    <p>No fields specified.</p>
  );
}
function DecisionControls({
  decisions,
  disabled,
  pending,
  refreshing,
  onDecision,
}: {
  decisions: DecisionKind[];
  disabled: boolean;
  pending: boolean;
  refreshing: boolean;
  onDecision: (kind: DecisionKind, reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const id = useId();
  if (!decisions.length)
    return <p>No decisions are currently available to you.</p>;
  return (
    <div className="resolution-controls" aria-busy={pending}>
      <label htmlFor={id}>Decision reason (required)</label>
      <textarea
        id={id}
        value={reason}
        required
        maxLength={1000}
        rows={3}
        disabled={disabled || pending}
        onChange={(event) => setReason(event.target.value)}
      />
      <p className="case-caption">Your reason is recorded with the decision.</p>
      <div className="resolution-actions">
        {decisions.map((kind) => (
          <Button
            key={kind}
            variant={kind === 'approve' ? 'default' : 'outline'}
            disabled={disabled || pending || refreshing || !reason.trim()}
            onClick={() => onDecision(kind, reason.trim())}
          >
            {caseLabel(kind)}
          </Button>
        ))}
      </div>
      {pending ? <p role="status">Recording decision…</p> : null}
    </div>
  );
}
