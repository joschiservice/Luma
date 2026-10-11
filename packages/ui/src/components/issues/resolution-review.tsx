import type {
  CaseDecision,
  CaseProgress,
  CaseReview,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { rich } from '@luma/i18n/rich';
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
import {
  caseStateLabel,
  executionStateLabel,
  recordKindLabel,
  verificationLabel,
  workflowStatusLabel,
} from './case-presentation';
import { CloseIssueDialog } from './close-issue-dialog';
import { IssuePageNavigation } from './issue-section';

type DecisionKind = Exclude<CaseDecision['kind'], 'close'>;

type Proposal = NonNullable<CaseReview['proposal']>;

const risks = {
  low: m.issues_review_risk_low,
  medium: m.issues_review_risk_medium,
  high: m.issues_review_risk_high,
} satisfies Record<Proposal['risk'], () => string>;

const decisionButtons = {
  approve: m.issues_review_approve,
  reject: m.issues_review_reject,
  escalate: m.issues_decision_escalate,
} satisfies Record<DecisionKind, () => string>;

function policyTitle(review: CaseReview, proposal: Proposal) {
  if (review.policyStale) return m.issues_review_policy_stale_title();
  switch (proposal.policy?.outcome) {
    case 'allowed':
      return m.issues_review_policy_allowed_title();
    case 'denied':
      return m.issues_review_policy_denied_title();
    case 'approval_required':
      return m.issues_review_policy_approval_title();
    default:
      return m.issues_review_policy_missing_title();
  }
}

function fieldLabel(value: string) {
  return caseLabel(
    value.replaceAll('.', ' ').replace(/([a-z])([A-Z])/g, '$1 $2'),
  );
}

/**
 * Presents a proposed change, what the workspace’s approval rules require, and the decisions the
 * reader may make, with caller-controlled submission state. Decisions stay available while the
 * caller refreshes in the background; the caller decides on the refreshed result.
 */
export function ResolutionReview({
  review,
  progress,
  connectionLabel,
  disabled = false,
  pending = false,
  checking = false,
  onDecision,
}: {
  review: CaseReview;
  progress?: CaseProgress;
  connectionLabel?: string | undefined;
  disabled?: boolean;
  pending?: boolean;
  checking?: boolean;
  onDecision: (kind: CaseDecision['kind'], reason: string) => void;
}) {
  const proposal = review.proposal;
  const canClose = review.permittedDecisions.includes('close');
  const decisions = review.permittedDecisions.filter(
    (kind): kind is DecisionKind =>
      kind !== 'close' && (!review.observeOnly || kind !== 'approve'),
  );
  const navigate = useContext(IssuePageNavigation);

  return (
    <article
      className="case-investigation recorded-findings resolution-review"
      aria-label={m.issues_section_resolution()}
    >
      <section>
        {canClose ? (
          <CloseIssueDialog
            progress={progress}
            disabled={disabled || pending}
            onClose={(reason) => onDecision('close', reason)}
          />
        ) : null}
        <h3>
          <ClipboardCheck size={16} aria-hidden="true" />{' '}
          {proposal ? m.issues_review_title() : m.issues_review_none_title()}
        </h3>
        {proposal ? (
          <>
            {review.observeOnly ? (
              <Alert tone="neutral" role="status">
                <AlertTitle>{m.issues_observe_only_title()}</AlertTitle>
                <AlertDescription>
                  {m.issues_observe_only_proposal()}
                </AlertDescription>
              </Alert>
            ) : null}
            <Card as="div" variant="subtle" className="resolution-proposal">
              <CardHeader className="resolution-proposal-heading">
                <h4>
                  <ArrowRightLeft size={16} aria-hidden="true" />
                  {fieldLabel(proposal.capability)}
                </h4>
                <Badge tone={proposal.risk === 'low' ? 'neutral' : 'warning'}>
                  {risks[proposal.risk]()}
                </Badge>
              </CardHeader>
              <p className="case-caption">
                {m.issues_review_versions({
                  proposal: proposal.version,
                  investigation: proposal.diagnosisRevision,
                })}
              </p>
              <dl className="resolution-facts">
                <dt>{m.issues_review_target_system()}</dt>
                <dd>{connectionLabel ?? proposal.connectionId}</dd>
                <dt>{m.issues_review_target_record()}</dt>
                <dd>
                  {recordKindLabel(proposal.target.kind)} · {proposal.target.id}
                </dd>
              </dl>
            </Card>
            <div className="resolution-change-group">
              <Card as="div" className="resolution-change-card">
                <CardTitle as="h4">
                  <ArrowRightLeft size={14} aria-hidden="true" />{' '}
                  {m.issues_review_changes()}
                </CardTitle>
                <Fields values={proposal.parameters} />
              </Card>
              <Card as="div" className="resolution-change-card">
                <CardTitle as="h4">
                  <Target size={14} aria-hidden="true" />{' '}
                  {m.issues_criteria_expected()}
                </CardTitle>
                <Fields values={proposal.expectedPostcondition} />
              </Card>
            </div>
            <Alert tone="warning" className="resolution-recovery">
              <AlertTitle>{m.issues_review_no_undo_title()}</AlertTitle>
              <AlertDescription>
                {m.issues_review_no_undo_body()}
              </AlertDescription>
            </Alert>
            <div className="resolution-preconditions">
              <h4>
                <ListChecks size={14} aria-hidden="true" />{' '}
                {m.issues_review_evidence_title()}
              </h4>
              {review.refreshable || proposal.approval ? (
                <p>
                  {proposal.approval
                    ? m.issues_review_evidence_recorded()
                    : m.issues_review_evidence_refreshed()}
                </p>
              ) : (
                <p>
                  {rich(m.issues_review_evidence_valid_until, {
                    time: (
                      <CaseTime value={proposal.preconditions.validUntil} />
                    ),
                  })}
                </p>
              )}
              {proposal.preconditions.evidenceRefs.length > 0 && (
                <Disclosure className="finding-sources">
                  <summary>
                    {m.issues_evidence_references({
                      count: proposal.preconditions.evidenceRefs.length,
                    })}
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
                  <Clock3 size={12} aria-hidden="true" />{' '}
                  {rich(m.issues_review_expires, {
                    time: <CaseTime value={proposal.expiresAt} />,
                  })}
                </p>
              ) : null}
            </div>
            <CaseNotice title={policyTitle(review, proposal)}>
              {review.policyStale
                ? m.issues_review_policy_stale_body()
                : proposal.policy?.reason === 'approval_required'
                  ? m.issues_review_policy_approval_body()
                  : (proposal.policy?.reason ??
                    m.issues_review_policy_missing_body())}
              {proposal.policy?.outcome === 'allowed'
                ? ` ${m.issues_review_policy_allowed_body()}`
                : null}
            </CaseNotice>
            {!proposal.available ? (
              <CaseNotice title={m.issues_review_unavailable_title()}>
                {m.issues_review_unavailable_body()}
              </CaseNotice>
            ) : null}
            {proposal.diagnosisRevision !== review.diagnosisRevision ? (
              <CaseNotice title={m.issues_review_outdated_title()}>
                {m.issues_review_outdated_body()}
              </CaseNotice>
            ) : null}
            {proposal.approval ? (
              <CaseNotice
                title={
                  proposal.approval.outcome === 'approved'
                    ? m.issues_review_approved_title()
                    : m.issues_review_rejected_title()
                }
              >
                {proposal.approval.outcome === 'approved'
                  ? m.issues_review_approved_body()
                  : m.issues_review_rejected_body()}
              </CaseNotice>
            ) : null}
          </>
        ) : (
          <>
            <p>
              {progress?.resolution
                ? m.issues_review_none_closed()
                : review.permittedDecisions.includes('escalate')
                  ? m.issues_review_none_escalate()
                  : m.issues_review_none_investigation()}
            </p>
            {navigate ? (
              <Button
                className="resolution-next-step"
                variant="outline"
                onClick={() => navigate('overview')}
              >
                {m.issues_review_view_next_step()}
              </Button>
            ) : null}
          </>
        )}
        {proposal && review.refreshable ? (
          <p className="case-caption">{m.issues_review_refresh_note()}</p>
        ) : null}
        {/* Fresh evidence preserves the draft; a changed action starts a new decision. */}
        {decisions.length || !canClose ? (
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
            decisions={decisions}
            disabled={disabled}
            pending={pending}
            checking={checking}
            onDecision={onDecision}
          />
        ) : null}
      </section>
      {navigate ? (
        proposal?.approval ||
        progress?.execution ||
        progress?.resolution ||
        progress?.state === 'escalated' ? (
          <Button variant="ghost" onClick={() => navigate('execution')}>
            {m.issues_review_view_progress()}
          </Button>
        ) : null
      ) : (
        <section aria-label={m.issues_section_execution()}>
          <h3>
            <Activity size={16} aria-hidden="true" />{' '}
            {m.issues_section_execution()}
          </h3>
          {progress ? (
            <>
              <p className="case-caption">
                {m.issues_review_progress_issue({
                  state: caseStateLabel(progress.state),
                })}
              </p>
              <div className="resolution-outcomes">
                <p>
                  {m.issues_review_progress_change({
                    state: progress.execution
                      ? executionStateLabel(progress.execution.state)
                      : m.issues_change_not_sent(),
                  })}
                </p>
                <p>
                  {m.issues_review_progress_check({
                    outcome: progress.execution?.verification
                      ? verificationLabel(
                          progress.execution.verification.outcome,
                        )
                      : m.issues_check_none(),
                  })}
                </p>
              </div>
              {progress.execution?.verification ? (
                <p className="case-caption">
                  {rich(m.issues_review_progress_checked, {
                    time: (
                      <CaseTime
                        value={progress.execution.verification.observedAt}
                      />
                    ),
                    evidence:
                      progress.execution.verification.observationRefs.join(
                        ', ',
                      ) || m.issues_review_progress_no_evidence(),
                  })}
                </p>
              ) : null}
              {progress.workflow.availability === 'unavailable' ? (
                <CaseNotice
                  title={m.issues_review_workflow_unavailable_title()}
                >
                  {m.issues_review_workflow_unavailable_body()}
                </CaseNotice>
              ) : progress.workflow.progress ? (
                <p>
                  {m.issues_progress_workflow({
                    status: workflowStatusLabel(progress.workflow),
                  })}
                </p>
              ) : null}
              {progress.resolution ? (
                <CaseNotice
                  title={
                    progress.resolution.kind === 'verification'
                      ? m.issues_resolution_verified_title()
                      : m.issues_resolution_human_title()
                  }
                >
                  {progress.resolution.kind === 'verification'
                    ? m.issues_resolution_verified_note()
                    : m.issues_resolution_human_note()}
                </CaseNotice>
              ) : (
                <p className="case-caption">
                  {m.issues_review_decision_note()}
                </p>
              )}
            </>
          ) : (
            <p>{m.issues_review_progress_unavailable()}</p>
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
          <dd>{value === null ? m.issues_not_specified() : String(value)}</dd>
        </div>
      ))}
    </dl>
  ) : (
    <p>{m.issues_review_fields_none()}</p>
  );
}

function DecisionControls({
  compactEscalation = false,
  decisions,
  disabled,
  pending,
  checking,
  onDecision,
}: {
  compactEscalation?: boolean;
  decisions: DecisionKind[];
  disabled: boolean;
  pending: boolean;
  checking: boolean;
  onDecision: (kind: CaseDecision['kind'], reason: string) => void;
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
  if (!decisions.length) return <p>{m.issues_review_decisions_none()}</p>;

  if (compact && !escalating)
    return (
      <Button
        ref={trigger}
        className="resolution-escalate-trigger"
        variant="outline"
        disabled={disabled || pending}
        onClick={() => setEscalating(true)}
      >
        <ArrowUpRight size={15} aria-hidden="true" />
        {m.issues_review_escalate()}
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
        {compact
          ? m.issues_review_escalate()
          : m.issues_review_decision_title()}
      </CardTitle>
      <label htmlFor={id}>
        {compact
          ? m.issues_review_escalate_reason()
          : m.issues_review_decision_reason()}
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
          ? m.issues_review_escalate_help()
          : m.issues_review_decision_help()}
      </p>
      <div className="resolution-actions">
        {decisions.map((kind) => (
          <Button
            key={kind}
            variant={kind === 'approve' ? 'default' : 'outline'}
            disabled={disabled || pending || !reason.trim()}
            onClick={() => onDecision(kind, reason.trim())}
          >
            {kind === 'approve' ? (
              <Check size={15} aria-hidden="true" />
            ) : kind === 'reject' ? (
              <X size={15} aria-hidden="true" />
            ) : (
              <ArrowUpRight size={15} aria-hidden="true" />
            )}
            {compact
              ? m.issues_review_escalate_confirm()
              : decisionButtons[kind]()}
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
            {m.common_cancel()}
          </Button>
        ) : null}
      </div>
      {pending ? (
        <p role="status">
          {checking
            ? m.issues_review_checking()
            : m.issues_review_saving_decision()}
        </p>
      ) : null}
    </Card>
  );
}
