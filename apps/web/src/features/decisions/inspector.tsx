import type { DecisionItem } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { rich } from '@luma/i18n/rich';
import { ActionDiff } from '@luma/ui/components/issues/action-diff';
import { CaseNotice } from '@luma/ui/components/issues/case-investigation';
import { IssuePanelClose } from '@luma/ui/components/issues/issue-panel-close';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button, buttonVariants } from '@luma/ui/components/primitives/button';
import { DomainIcon } from '@luma/ui/components/primitives/domain-icon';
import { PersonPicker } from '@luma/ui/components/primitives/person-picker';
import { StatePill } from '@luma/ui/components/primitives/state';
import {
  formatWorkspaceDateTime,
  WorkspaceDate,
  WorkspaceTimezone,
} from '@luma/ui/components/primitives/workspace-date';
import { Link } from '@tanstack/react-router';
import { ArrowUpRight, Clock } from 'lucide-react';
import { type ReactNode, useContext, useId } from 'react';

import { useNow } from '../../kit/live/now';
import {
  assigneeOptions,
  decisionStatus,
  domainIcons,
  domainLabels,
  evidenceLabels,
  impactLabels,
  kindLabels,
  localizeReturnDecision,
  memberName,
  timeLeft,
} from './presentation';

export type Member = {
  userId: string;
  name?: string | undefined;
  email?: string | undefined;
};

/**
 * Who the reader may assign: anyone with permission to assign decisions, only themselves with
 * permission to take decisions, or nobody.
 */
export type AssignmentAccess = 'anyone' | 'self' | 'none';

/** Shows how long a proposal keeps its authority. Expiring deadlines are emphasized. */
export function DecisionDeadline({
  deadline,
  now,
}: {
  deadline: string | null;
  /** A fixed time to count down from; the shared clock by default. */
  now?: number | undefined;
}) {
  const timeZone = useContext(WorkspaceTimezone);
  const clock = useNow();
  if (!deadline) return null;
  const left = Date.parse(deadline) - (now ?? clock);

  return (
    <span
      className="decision-deadline"
      data-urgency={
        left <= 0 ? 'expired' : left <= 30 * 60_000 ? 'soon' : undefined
      }
      title={m.decisions_deadline_title({
        time: formatWorkspaceDateTime(deadline, timeZone),
      })}
    >
      <Clock size={13} aria-hidden="true" />
      <span className="sr-only">{m.decisions_deadline_prefix()} </span>
      {timeLeft(deadline, now ?? clock)}
    </span>
  );
}

function RecordLinks({
  organizationId,
  item,
}: {
  organizationId: string;
  item: DecisionItem;
}) {
  const link = buttonVariants({ variant: 'outline', size: 'sm' });
  const record = item.record;
  const owner = item.owner;

  return (
    <div className="decision-links">
      {item.outcome?.purchaseOrderId ? (
        <Link
          className={link}
          to="/app/$organizationId/procurement/$purchaseOrderId"
          params={{
            organizationId,
            purchaseOrderId: item.outcome.purchaseOrderId,
          }}
        >
          {m.decisions_open_purchase_order()}{' '}
          <ArrowUpRight aria-hidden="true" />
        </Link>
      ) : null}
      {item.outcome?.definitionId &&
      item.outcome.runId &&
      owner.kind !== 'workflow_run' ? (
        <Link
          className={link}
          to="/app/$organizationId/workflows/$definitionId"
          params={{ organizationId, definitionId: item.outcome.definitionId }}
          hash={`run-${item.outcome.runId}`}
        >
          {m.decisions_open_run()} <ArrowUpRight aria-hidden="true" />
        </Link>
      ) : null}

      {record?.kind === 'order' ? (
        <Link
          className={link}
          to="/app/$organizationId/orders/$orderId"
          params={{ organizationId, orderId: record.id }}
        >
          {m.decisions_open_order()} <ArrowUpRight aria-hidden="true" />
        </Link>
      ) : record?.kind === 'fulfillment' ? (
        <Link
          className={link}
          to="/app/$organizationId/fulfillment/$fulfillmentId"
          params={{ organizationId, fulfillmentId: record.id }}
        >
          {m.decisions_open_fulfillment()} <ArrowUpRight aria-hidden="true" />
        </Link>
      ) : record?.kind === 'position' ? (
        <Link
          className={link}
          to="/app/$organizationId/inventory/$positionId"
          params={{ organizationId, positionId: record.id }}
        >
          {m.decisions_open_position()} <ArrowUpRight aria-hidden="true" />
        </Link>
      ) : record ? (
        <Link
          className={link}
          to="/app/$organizationId/records/$kind/$recordId"
          params={{ organizationId, kind: record.kind, recordId: record.id }}
        >
          {m.decisions_open_record()} <ArrowUpRight aria-hidden="true" />
        </Link>
      ) : null}
      {owner.kind === 'return_case' ? (
        <Link
          className={link}
          to="/app/$organizationId/returns/cases/$caseId"
          params={{ organizationId, caseId: owner.caseId }}
        >
          {m.returns_service_open_case()} <ArrowUpRight aria-hidden="true" />
        </Link>
      ) : owner.kind === 'case' ? (
        <Link
          className={link}
          to="/app/$organizationId/exceptions/$exceptionId/detail"
          params={{ organizationId, exceptionId: owner.exceptionId }}
          search={{ view: 'needs_you' }}
        >
          {m.decisions_open_issue()} <ArrowUpRight aria-hidden="true" />
        </Link>
      ) : owner.kind === 'workflow_run' ? (
        <Link
          className={link}
          to="/app/$organizationId/workflows/$definitionId"
          params={{ organizationId, definitionId: owner.definitionId }}
          hash={`run-${owner.runId}`}
        >
          {m.decisions_open_run()} <ArrowUpRight aria-hidden="true" />
        </Link>
      ) : owner.kind === 'purchasing_plan' ? (
        <Link
          className={link}
          to="/app/$organizationId/procurement"
          params={{ organizationId }}
          search={{ tab: 'purchasing' }}
        >
          {m.purchasing_title()} <ArrowUpRight aria-hidden="true" />
        </Link>
      ) : owner.kind === 'message_thread' ? (
        <Link
          className={link}
          to="/app/$organizationId/inbox"
          params={{ organizationId }}
          search={{ thread: owner.threadId, view: 'all' }}
        >
          {m.decisions_open_thread()} <ArrowUpRight aria-hidden="true" />
        </Link>
      ) : null}
    </div>
  );
}

/**
 * Lets people take or release a decision; people who can assign decisions can also hand it to
 * anyone.
 */
function Assignment({
  item,
  members,
  self,
  access,
  pending,
  onAssign,
}: {
  item: DecisionItem;
  members: readonly Member[];
  self: string | undefined;
  access: AssignmentAccess;
  pending: boolean;
  onAssign: (assigneeId: string | null) => void;
}) {
  const holder = item.assignment?.assigneeId ?? null;
  const staff = access === 'anyone';
  const selfService = access !== 'none';
  const label = memberName(holder, members, self) ?? m.decisions_owner_none();

  return (
    <div className="decision-assignment">
      <span>{label}</span>
      {holder === self && self && selfService ? (
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => onAssign(null)}
        >
          {m.decisions_release()}
        </Button>
      ) : self && selfService && (holder === null || staff) ? (
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => onAssign(self)}
        >
          {holder === null ? m.decisions_take() : m.decisions_take_over()}
        </Button>
      ) : null}
      {staff && members.length > 1 ? (
        <PersonPicker
          label={m.decisions_assign_placeholder()}
          title={m.decisions_assign_label()}
          disabled={pending}
          people={assigneeOptions(members, holder, self)}
          onSelect={onAssign}
        />
      ) : null}
    </div>
  );
}

/**
 * Explains one decision: why a person is needed, the exact change, what each response causes
 * and how current the evidence is. The owner's review, passed as `review`, takes the response.
 */
export function DecisionInspector({
  organizationId,
  item: rawItem,
  departed = false,
  previousChange,
  members,
  self,
  assignmentAccess,
  now,
  navigation,
  onClose,
  onAssign,
  assigning = false,
  assignError,
  review,
}: {
  organizationId: string;
  item: DecisionItem;
  /** The item has left the queue since it was opened. */
  departed?: boolean;
  previousChange?: DecisionItem['change'] | undefined;
  members: readonly Member[];
  self: string | undefined;
  assignmentAccess: AssignmentAccess;
  /** A fixed time for the deadline; the shared clock by default. */
  now?: number | undefined;
  navigation?: ReactNode;
  onClose: () => void;
  onAssign: (assigneeId: string | null) => void;
  assigning?: boolean;
  assignError?: string | undefined;
  review: ReactNode;
}) {
  previousChange ??= rawItem.previousChange;
  const item = localizeReturnDecision(rawItem);
  const id = useId();
  const status = item.outcome
    ? {
        state:
          item.outcome.next === 'verified'
            ? ('verified' as const)
            : ('idle' as const),
        label: {
          approved: m.decisions_answer_approved,
          rejected: m.decisions_answer_rejected,
          expired: m.decisions_answer_expired,
          resolved: m.decisions_answer_resolved,
        }[item.outcome.state](),
      }
    : departed
      ? { state: 'idle' as const, label: m.decisions_departed_title() }
      : decisionStatus(item);
  const requester = memberName(item.requesterId, members, self);
  const approval = item.reason === 'approval' || item.reason === 'run';

  return (
    <article className="decision-inspector" aria-labelledby={`${id}-title`}>
      <div className="issue-panel-header">
        <header className="issue-inspector-header">
          <div className="issue-panel-identity">
            <span className="decision-eyebrow">
              <DomainIcon domain={domainIcons[item.domain]} size="xs" />
              {kindLabels[item.kind]()} · {domainLabels[item.domain]()}
            </span>
            <div className="issue-panel-heading">
              <h2
                id={`${id}-title`}
                title={
                  item.observeOnly ? m.issues_observe_only_title() : item.title
                }
              >
                {item.observeOnly ? m.issues_observe_only_title() : item.title}
              </h2>
            </div>
            <div className="issue-panel-status">
              <StatePill state={status.state}>{status.label}</StatePill>
              {!departed && !item.outcome ? (
                <DecisionDeadline deadline={item.deadline} now={now} />
              ) : null}
              <span
                className="issue-severity"
                data-severity={
                  item.impact.level === 'high' ? 'high' : undefined
                }
              >
                {impactLabels[item.impact.level]()}
              </span>
            </div>
          </div>
          <div className="issue-panel-navigation">
            {navigation}
            <IssuePanelClose onClose={onClose} />
          </div>
        </header>
      </div>
      {previousChange ? (
        <CaseNotice title={m.decisions_proposal_changed()}>
          <p>{m.decisions_proposal_changed_help()}</p>
          <dl>
            {item.change
              .filter((field) =>
                previousChange.some(
                  (old) =>
                    old.label === field.label && old.value !== field.value,
                ),
              )
              .map((field) => (
                <div key={field.label}>
                  <dt>{field.label}</dt>
                  <dd>
                    {previousChange.find((old) => old.label === field.label)
                      ?.value ?? m.common_not_reported()}{' '}
                    → {field.value}
                  </dd>
                </div>
              ))}
          </dl>
        </CaseNotice>
      ) : null}
      {item.outcome ? (
        <CaseNotice title={status.label}>
          <p>
            {item.outcome.actorId === self
              ? m.decisions_answer_you()
              : [item.outcome.actorName, item.outcome.actorEmail]
                  .filter(Boolean)
                  .join(' · ') ||
                (item.outcome.actorId
                  ? m.common_actor_former_member()
                  : m.decisions_answer_expired())}{' '}
            {item.outcome.at ? <WorkspaceDate value={item.outcome.at} /> : null}
          </p>
          {item.outcome.state === 'approved' ? (
            <p>
              {{
                pending: item.outcome.workflow
                  ? m.decisions_answer_luma_runs
                  : m.decisions_answer_requester_runs,
                running: m.decisions_answer_running,
                verified: m.decisions_answer_verified,
                failed: m.decisions_answer_failed,
                uncertain: m.decisions_answer_uncertain,
              }[item.outcome.next]()}
            </p>
          ) : null}
        </CaseNotice>
      ) : departed ? (
        <CaseNotice title={m.decisions_departed_title()}>
          {m.decisions_departed_text()}
        </CaseNotice>
      ) : null}
      <div className="decision-brief">
        {item.diff && (item.kind !== 'replenishment' || !review) ? (
          <ActionDiff diff={item.diff} />
        ) : null}
        <section className="decision-section" aria-labelledby={`${id}-why`}>
          <h3 id={`${id}-why`}>{m.decisions_why_title()}</h3>
          <p>
            {item.observeOnly
              ? m.issues_observe_only_proposal()
              : item.kind === 'human_task'
                ? m.authoring_coordination_waiting_for_answer()
                : item.why}
          </p>
          {item.response === 'awaiting_other' ? (
            <p className="decision-note">{m.decisions_note_awaiting_other()}</p>
          ) : item.response === 'view_only' ? (
            <p className="decision-note">
              {item.reason === 'run'
                ? m.decisions_note_requester_runs()
                : m.decisions_note_view_only()}
            </p>
          ) : null}
        </section>
        {item.kind !== 'replenishment' || !review ? (
          <section
            className="decision-section"
            aria-labelledby={`${id}-change`}
          >
            <h3 id={`${id}-change`}>
              {approval
                ? m.decisions_change_title()
                : m.decisions_affects_title()}
            </h3>
            <dl className="decision-facts">
              {item.change.map((fact) => (
                <div key={fact.label}>
                  <dt>
                    {item.kind === 'human_task'
                      ? m.authoring_coordination_evidence()
                      : fact.label}
                  </dt>
                  <dd>
                    {item.kind === 'human_task'
                      ? ({
                          text: m.authoring_coordination_text(),
                          link: m.authoring_coordination_link(),
                          record: m.authoring_coordination_record(),
                        }[fact.value as 'text' | 'link' | 'record'] ??
                        fact.value)
                      : fact.value}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ) : null}
        <section className="decision-section" aria-labelledby={`${id}-effect`}>
          <h3 id={`${id}-effect`}>{m.decisions_effect_title()}</h3>
          <dl className="decision-consequences">
            {item.consequences.map((consequence) => (
              <div key={consequence.response}>
                <dt>
                  {item.kind === 'human_task'
                    ? m.authoring_coordination_answer()
                    : consequence.response}
                </dt>
                <dd>
                  {item.kind === 'human_task'
                    ? m.authoring_coordination_answer_effect()
                    : consequence.text}
                </dd>
              </div>
            ))}
          </dl>
        </section>
        <section
          className="decision-section"
          aria-labelledby={`${id}-evidence`}
        >
          <h3 id={`${id}-evidence`}>{m.decisions_evidence_title()}</h3>
          <dl className="decision-facts">
            <div>
              <dt>{m.decisions_evidence_label()}</dt>
              <dd>
                <Badge
                  tone={
                    item.evidence.state === 'fresh'
                      ? 'success'
                      : item.evidence.state === 'stale'
                        ? 'warning'
                        : 'neutral'
                  }
                >
                  {evidenceLabels[item.evidence.state]()}
                </Badge>
                {item.evidence.observedAt ? (
                  <span>
                    {rich(m.decisions_evidence_read, {
                      time: <WorkspaceDate value={item.evidence.observedAt} />,
                    })}
                  </span>
                ) : (
                  <span>{m.decisions_evidence_read_unknown()}</span>
                )}
              </dd>
            </div>
            {item.deadline ? (
              <div>
                <dt>{m.decisions_deadline_label()}</dt>
                <dd>
                  <WorkspaceDate value={item.deadline} />
                  {item.kind !== 'human_task' ? (
                    <span>{m.decisions_deadline_note()}</span>
                  ) : null}
                </dd>
              </div>
            ) : null}
            <div>
              <dt>{m.decisions_impact_label()}</dt>
              <dd>
                {item.impact.text && (item.kind !== 'replenishment' || !review)
                  ? m.decisions_impact_detail({
                      impact: impactLabels[item.impact.level](),
                      detail: item.impact.text,
                    })
                  : impactLabels[item.impact.level]()}
              </dd>
            </div>
            <div>
              <dt>{m.decisions_requested_label()}</dt>
              <dd>
                {requester ? <span>{requester}</span> : null}
                <WorkspaceDate value={item.requestedAt} />
              </dd>
            </div>
            <div>
              <dt>{m.decisions_owner_label()}</dt>
              <dd>
                <Assignment
                  item={item}
                  members={members}
                  self={self}
                  access={departed || item.outcome ? 'none' : assignmentAccess}
                  pending={assigning}
                  onAssign={onAssign}
                />
              </dd>
            </div>
          </dl>
          {assignError ? (
            <p role="alert" className="decision-error">
              {assignError}
            </p>
          ) : null}
          {item.observeOnly ? (
            <CaseNotice title={m.issues_observe_only_title()}>
              {m.issues_observe_only_proposal()}
            </CaseNotice>
          ) : null}
          <RecordLinks organizationId={organizationId} item={item} />
        </section>
      </div>
      <section className="decision-review" aria-labelledby={`${id}-review`}>
        <h3 id={`${id}-review`}>{m.decisions_review_title()}</h3>
        <p className="decision-note">
          {item.owner.kind === 'human_task'
            ? m.authoring_coordination_answer_effect()
            : item.owner.kind === 'case'
              ? m.decisions_review_note_case()
              : item.owner.kind === 'workflow_run'
                ? m.decisions_review_note_run()
                : m.decisions_review_note_record()}
        </p>
        {review}
      </section>
    </article>
  );
}
