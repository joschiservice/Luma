import type {
  CaseDecision,
  CaseProgress,
  CaseReview,
} from '@luma/api-contract';
import {
  Activity,
  ArrowRightLeft,
  ArrowUpRight,
  Check,
  ClipboardCheck,
  Clock3,
  ListChecks,
  MessageSquare,
  Target,
  X,
} from 'lucide-react';
import { useContext, useEffect, useId, useRef, useState } from 'react';

import { Alert, AlertDescription, AlertTitle } from '../primitives/alert';
import { Badge } from '../primitives/badge';
import { Button } from '../primitives/button';
import { Card, CardHeader, CardTitle } from '../primitives/card';
import { Disclosure } from '../primitives/disclosure';
import { caseLabel, CaseNotice, CaseTime } from './case-investigation';
import { IssuePageNavigation } from './issue-section';

type DecisionKind = CaseDecision['kind'];

function fieldLabel(value: string) {
  return caseLabel(
    value.replaceAll('.', ' ').replace(/([a-z])([A-Z])/g, '$1 $2'),
  );
}

/**
 * Presents a proposal, policy result, and permitted decisions with caller-controlled
 * submission state.
 */
export function ResolutionReview({
  review,
  progress,
  connectionLabel,
  disabled = false,
  pending = false,
  checking = false,
  refreshing = false,
  onDecision,
}: {
  review: CaseReview;
  progress?: CaseProgress;
  connectionLabel?: string | undefined;
  disabled?: boolean;
  pending?: boolean;
  checking?: boolean;
  refreshing?: boolean;
  onDecision: (kind: DecisionKind, reason: string) => void;
}) {
  const proposal = review.proposal;
  const navigate = useContext(IssuePageNavigation);

  return (
    <article
      className="case-investigation recorded-findings resolution-review"
      aria-label="Resolution review"
    >
      <section>
        <h3>
          <ClipboardCheck size={16} aria-hidden="true" />{' '}
          {proposal
            ? 'Review the proposed correction'
            : 'No proposed correction'}
        </h3>
        {proposal ? (
          <>
            <Card as="div" variant="subtle" className="resolution-proposal">
              <CardHeader className="resolution-proposal-heading">
                <h4>
                  <ArrowRightLeft size={16} aria-hidden="true" />
                  {fieldLabel(proposal.capability)}
                </h4>
                <Badge tone={proposal.risk === 'low' ? 'neutral' : 'warning'}>
                  {caseLabel(proposal.risk)} risk
                </Badge>
              </CardHeader>
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
              </dl>
            </Card>
            <div className="resolution-change-group">
              <Card as="div" className="resolution-change-card">
                <CardTitle as="h4">
                  <ArrowRightLeft size={14} aria-hidden="true" /> Proposed
                  changes
                </CardTitle>
                <Fields values={proposal.parameters} />
              </Card>
              <Card as="div" className="resolution-change-card">
                <CardTitle as="h4">
                  <Target size={14} aria-hidden="true" /> Expected result
                </CardTitle>
                <Fields values={proposal.expectedPostcondition} />
              </Card>
            </div>
            <Alert tone="warning" className="resolution-recovery">
              <AlertTitle>Recovery not specified</AlertTitle>
              <AlertDescription>
                No recovery action is specified for this proposal. Do not assume
                the change can be undone.
              </AlertDescription>
            </Alert>
            <div className="resolution-preconditions">
              <h4>
                <ListChecks size={14} aria-hidden="true" /> Preconditions
              </h4>
              {review.refreshable || proposal.approval ? (
                <p>
                  {proposal.approval
                    ? 'The evidence used for this decision is recorded below.'
                    : 'We keep the evidence up to date while you review.'}
                </p>
              ) : (
                <p>
                  Evidence must remain current through{' '}
                  <CaseTime value={proposal.preconditions.validUntil} />.
                </p>
              )}
              {proposal.preconditions.evidenceRefs.length > 0 && (
                <Disclosure className="finding-sources">
                  <summary>
                    Evidence references (
                    {proposal.preconditions.evidenceRefs.length})
                  </summary>
                  <ul>
                    {proposal.preconditions.evidenceRefs.map((ref) => (
                      <li key={ref}>
                        <code>{ref}</code>
                      </li>
                    ))}
                  </ul>
                </Disclosure>
              )}
              {!review.refreshable && !proposal.approval ? (
                <p className="case-caption">
                  <Clock3 size={12} aria-hidden="true" /> Proposal expires{' '}
                  <CaseTime value={proposal.expiresAt} />.
                </p>
              ) : null}
            </div>
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
              {proposal.policy?.reason === 'approval_required'
                ? 'Another authorized operator must approve this change.'
                : (proposal.policy?.reason ??
                  'Execution is not authorized without a current policy result.')}
              {proposal.policy?.outcome === 'allowed'
                ? ' No approval click is needed. Execution and verification are tracked separately.'
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
                  ? 'The decision is recorded. Execution and verification are tracked separately.'
                  : 'This proposal has not been approved for execution.'}
              </CaseNotice>
            ) : null}
          </>
        ) : (
          <>
            <p>
              {progress?.resolution
                ? 'This issue is closed. No correction is available to review.'
                : review.permittedDecisions.includes('escalate')
                  ? 'Follow the recommended manual steps or escalate this issue for further review.'
                  : 'Review the investigation for the recommended next step.'}
            </p>
            {navigate ? (
              <Button
                className="resolution-next-step"
                variant="outline"
                onClick={() => navigate('overview')}
              >
                View recommended next step
              </Button>
            ) : null}
          </>
        )}
        {proposal && review.refreshable ? (
          <p className="case-caption">
            We’ll check current conditions before applying your approved change.
            If the action changes, we’ll ask you to review it again.
          </p>
        ) : null}
        {/* Fresh evidence preserves the draft; a changed action starts a new decision. */}
        <DecisionControls
          key={JSON.stringify([
            proposal?.version,
            proposal?.capability,
            proposal?.capabilityVersion,
            proposal?.requestedBy,
            proposal?.connectionId,
            proposal?.target,
            proposal?.parameters,
            proposal?.expectedPostcondition,
            proposal?.risk,
            proposal?.available,
            proposal?.policy?.policyVersion,
            proposal?.policy?.outcome,
            proposal?.policy?.reason,
          ])}
          compactEscalation={!proposal && !!navigate}
          decisions={review.permittedDecisions}
          disabled={disabled}
          pending={pending}
          checking={checking}
          refreshing={refreshing}
          onDecision={onDecision}
        />
      </section>
      {navigate ? (
        proposal?.approval ||
        progress?.execution ||
        progress?.resolution ||
        progress?.state === 'escalated' ? (
          <Button variant="ghost" onClick={() => navigate('execution')}>
            View execution status
          </Button>
        ) : null
      ) : (
        <section aria-label="Execution and verification">
          <h3>
            <Activity size={16} aria-hidden="true" /> Execution and verification
          </h3>
          {progress ? (
            <>
              <p className="case-caption">Issue: {caseLabel(progress.state)}</p>
              <div className="resolution-outcomes">
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
              </div>
              {progress.execution?.verification ? (
                <p className="case-caption">
                  Observed{' '}
                  <CaseTime
                    value={progress.execution.verification.observedAt}
                  />{' '}
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
                  A recorded decision does not establish a successful
                  correction.
                </p>
              )}
            </>
          ) : (
            <p>Current execution and verification status is unavailable.</p>
          )}
        </section>
      )}
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
  compactEscalation = false,
  decisions,
  disabled,
  pending,
  checking,
  refreshing,
  onDecision,
}: {
  compactEscalation?: boolean;
  decisions: DecisionKind[];
  disabled: boolean;
  pending: boolean;
  checking: boolean;
  refreshing: boolean;
  onDecision: (kind: DecisionKind, reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [escalating, setEscalating] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const compact =
    compactEscalation && decisions.length === 1 && decisions[0] === 'escalate';
  const id = useId();
  useEffect(() => {
    if (compact && escalating) textarea.current?.focus({ preventScroll: true });
  }, [compact, escalating]);
  if (!decisions.length)
    return <p>No decisions are currently available to you.</p>;

  if (compact && !escalating)
    return (
      <Button
        ref={trigger}
        className="resolution-escalate-trigger"
        variant="outline"
        disabled={disabled || pending || refreshing}
        onClick={() => setEscalating(true)}
      >
        <ArrowUpRight size={15} aria-hidden="true" />
        Escalate issue
      </Button>
    );

  return (
    <Card
      as="div"
      variant="subtle"
      className="resolution-controls"
      aria-busy={pending}
    >
      <CardTitle as="h4">
        <MessageSquare size={15} aria-hidden="true" />{' '}
        {compact ? 'Escalate issue' : 'Your decision'}
      </CardTitle>
      <label htmlFor={id}>
        {compact
          ? 'Why does this need escalation?'
          : 'Decision reason (required)'}
      </label>
      <textarea
        id={id}
        ref={textarea}
        value={reason}
        required
        maxLength={1000}
        rows={compact ? 2 : 3}
        disabled={disabled || pending}
        onChange={(event) => setReason(event.target.value)}
      />
      <p className="case-caption">
        {compact
          ? 'A reason is required. Escalation marks this issue for further review and records your reason. It does not apply a correction.'
          : 'Your reason is recorded with the decision.'}
      </p>
      <div className="resolution-actions">
        {decisions.map((kind) => (
          <Button
            key={kind}
            variant={kind === 'approve' ? 'default' : 'outline'}
            disabled={disabled || pending || refreshing || !reason.trim()}
            onClick={() => onDecision(kind, reason.trim())}
          >
            {kind === 'approve' ? (
              <Check size={15} aria-hidden="true" />
            ) : kind === 'reject' ? (
              <X size={15} aria-hidden="true" />
            ) : (
              <ArrowUpRight size={15} aria-hidden="true" />
            )}
            {compact ? 'Confirm escalation' : caseLabel(kind)}
          </Button>
        ))}
        {compact ? (
          <Button
            variant="ghost"
            disabled={pending}
            onClick={() => {
              setEscalating(false);
              requestAnimationFrame(() => trigger.current?.focus());
            }}
          >
            Cancel
          </Button>
        ) : null}
      </div>
      {pending ? (
        <p role="status">
          {checking ? 'Checking current conditions…' : 'Recording decision…'}
        </p>
      ) : null}
    </Card>
  );
}
