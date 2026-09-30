import type { DecisionItem } from '@luma/api-contract';
import { CaseNotice } from '@luma/ui/components/issues/case-investigation';
import { IssuePanelClose } from '@luma/ui/components/issues/issue-panel-close';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button, buttonVariants } from '@luma/ui/components/primitives/button';
import { DomainIcon } from '@luma/ui/components/primitives/domain-icon';
import { Select } from '@luma/ui/components/primitives/select';
import { StatePill } from '@luma/ui/components/primitives/state';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { Link } from '@tanstack/react-router';
import { ArrowUpRight, Clock } from 'lucide-react';
import { type ReactNode, useId } from 'react';

import {
  decisionStatus,
  domainIcons,
  domainLabels,
  evidenceLabels,
  impactLabels,
  kindLabels,
  memberName,
  timeLeft,
} from './presentation';

export type Member = {
  userId: string;
  name?: string | undefined;
  email?: string | undefined;
  role: 'owner' | 'admin' | 'member';
};

/** Shows how long a proposal keeps its authority. Expiring deadlines are emphasized. */
export function DecisionDeadline({
  deadline,
  now,
}: {
  deadline: string | null;
  now: number;
}) {
  if (!deadline) return null;
  const left = Date.parse(deadline) - now;

  return (
    <span
      className="decision-deadline"
      data-urgency={
        left <= 0 ? 'expired' : left <= 30 * 60_000 ? 'soon' : undefined
      }
      title={`Expires ${deadline}`}
    >
      <Clock size={13} aria-hidden="true" />
      <span className="sr-only">Deadline: </span>
      {timeLeft(deadline, now)}
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
      {record?.kind === 'order' ? (
        <Link
          className={link}
          to="/app/$organizationId/orders/$orderId"
          params={{ organizationId, orderId: record.id }}
        >
          Open order <ArrowUpRight aria-hidden="true" />
        </Link>
      ) : record?.kind === 'fulfillment' ? (
        <Link
          className={link}
          to="/app/$organizationId/fulfillment/$fulfillmentId"
          params={{ organizationId, fulfillmentId: record.id }}
        >
          Open fulfillment <ArrowUpRight aria-hidden="true" />
        </Link>
      ) : record?.kind === 'position' ? (
        <Link
          className={link}
          to="/app/$organizationId/inventory/$positionId"
          params={{ organizationId, positionId: record.id }}
        >
          Open stock position <ArrowUpRight aria-hidden="true" />
        </Link>
      ) : record ? (
        <Link
          className={link}
          to="/app/$organizationId/records/$kind/$recordId"
          params={{ organizationId, kind: record.kind, recordId: record.id }}
        >
          Open record <ArrowUpRight aria-hidden="true" />
        </Link>
      ) : null}
      {owner.kind === 'case' ? (
        <Link
          className={link}
          to="/app/$organizationId/exceptions/$exceptionId/detail"
          params={{ organizationId, exceptionId: owner.exceptionId }}
          search={{ view: 'needs_you' }}
        >
          Open issue <ArrowUpRight aria-hidden="true" />
        </Link>
      ) : owner.kind === 'workflow_run' ? (
        <Link
          className={link}
          to="/app/$organizationId/workflows/$definitionId"
          params={{ organizationId, definitionId: owner.definitionId }}
        >
          Open workflow run <ArrowUpRight aria-hidden="true" />
        </Link>
      ) : null}
    </div>
  );
}

/** Lets members take or release a decision; owners and admins can also hand it to anyone. */
function Assignment({
  item,
  members,
  self,
  role,
  pending,
  onAssign,
}: {
  item: DecisionItem;
  members: readonly Member[];
  self: string | undefined;
  role: Member['role'] | undefined;
  pending: boolean;
  onAssign: (assigneeId: string | null) => void;
}) {
  const holder = item.assignment?.assigneeId ?? null;
  const staff = role === 'owner' || role === 'admin';
  const label = memberName(holder, members, self) ?? 'Unassigned';

  return (
    <div className="decision-assignment">
      <span>{label}</span>
      {holder === self && self ? (
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => onAssign(null)}
        >
          Release
        </Button>
      ) : self && (holder === null || staff) ? (
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => onAssign(self)}
        >
          {holder === null ? 'Take it' : 'Take over'}
        </Button>
      ) : null}
      {staff && members.length > 1 ? (
        <Select<string>
          aria-label="Assign to a member"
          className="decision-assignee"
          placeholder="Assign to…"
          value={null}
          disabled={pending}
          options={members
            .filter((member) => member.userId !== holder)
            .map((member) => ({
              value: member.userId,
              label:
                member.userId === self
                  ? 'You'
                  : member.name || member.email || 'Member',
            }))}
          onValueChange={(value) => {
            if (value) onAssign(value);
          }}
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
  item,
  departed = false,
  members,
  self,
  role,
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
  members: readonly Member[];
  self: string | undefined;
  role: Member['role'] | undefined;
  now: number;
  navigation?: ReactNode;
  onClose: () => void;
  onAssign: (assigneeId: string | null) => void;
  assigning?: boolean;
  assignError?: string | undefined;
  review: ReactNode;
}) {
  const id = useId();
  const status = decisionStatus(item);
  const requester = memberName(item.requesterId, members, self);
  const approval = item.reason === 'approval' || item.reason === 'run';

  return (
    <article className="decision-inspector" aria-labelledby={`${id}-title`}>
      <div className="issue-panel-header">
        <header className="issue-inspector-header">
          <div className="issue-panel-identity">
            <span className="decision-eyebrow">
              <DomainIcon domain={domainIcons[item.domain]} size="xs" />
              {kindLabels[item.kind]} · {domainLabels[item.domain]}
            </span>
            <div className="issue-panel-heading">
              <h2 id={`${id}-title`} title={item.title}>
                {item.title}
              </h2>
            </div>
            <div className="issue-panel-status">
              <StatePill state={status.state}>{status.label}</StatePill>
              <DecisionDeadline deadline={item.deadline} now={now} />
              <span
                className="issue-severity"
                data-severity={
                  item.impact.level === 'high' ? 'high' : undefined
                }
              >
                {impactLabels[item.impact.level]}
              </span>
            </div>
          </div>
          <div className="issue-panel-navigation">
            {navigation}
            <IssuePanelClose onClose={onClose} />
          </div>
        </header>
      </div>
      {departed ? (
        <CaseNotice title="This decision has left the queue">
          It was answered, expired or changed, possibly on another surface. The
          owner’s current state is shown below.
        </CaseNotice>
      ) : null}
      <div className="decision-brief">
        <section className="decision-section" aria-labelledby={`${id}-why`}>
          <h3 id={`${id}-why`}>Why you’re needed</h3>
          <p>{item.why}</p>
          {item.response === 'awaiting_other' ? (
            <p className="decision-note">
              You requested this, so a different owner or admin has to approve
              it. You can still follow it here.
            </p>
          ) : item.response === 'view_only' ? (
            <p className="decision-note">
              {item.reason === 'run'
                ? 'Only the person who requested it can run it.'
                : 'Your role can follow this decision. Owners and admins respond to it.'}
            </p>
          ) : null}
        </section>
        <section className="decision-section" aria-labelledby={`${id}-change`}>
          <h3 id={`${id}-change`}>
            {approval ? 'Proposed change' : 'What it affects'}
          </h3>
          <dl className="decision-facts">
            {item.change.map((fact) => (
              <div key={fact.label}>
                <dt>{fact.label}</dt>
                <dd>{fact.value}</dd>
              </div>
            ))}
          </dl>
        </section>
        <section className="decision-section" aria-labelledby={`${id}-effect`}>
          <h3 id={`${id}-effect`}>What your response does</h3>
          <dl className="decision-consequences">
            {item.consequences.map((consequence) => (
              <div key={consequence.response}>
                <dt>{consequence.response}</dt>
                <dd>{consequence.text}</dd>
              </div>
            ))}
          </dl>
        </section>
        <section
          className="decision-section"
          aria-labelledby={`${id}-evidence`}
        >
          <h3 id={`${id}-evidence`}>Evidence and ownership</h3>
          <dl className="decision-facts">
            <div>
              <dt>Evidence</dt>
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
                  {evidenceLabels[item.evidence.state]}
                </Badge>
                {item.evidence.observedAt ? (
                  <span>
                    Observed <WorkspaceDate value={item.evidence.observedAt} />
                  </span>
                ) : (
                  <span>Observation time unknown</span>
                )}
              </dd>
            </div>
            {item.deadline ? (
              <div>
                <dt>Deadline</dt>
                <dd>
                  <WorkspaceDate value={item.deadline} />
                  <span>Approval doesn’t extend it.</span>
                </dd>
              </div>
            ) : null}
            <div>
              <dt>Impact</dt>
              <dd>
                {impactLabels[item.impact.level]}
                {item.impact.text ? ` · ${item.impact.text}` : ''}
              </dd>
            </div>
            <div>
              <dt>Requested</dt>
              <dd>
                {requester ? <span>{requester}</span> : null}
                <WorkspaceDate value={item.requestedAt} />
              </dd>
            </div>
            <div>
              <dt>Owner</dt>
              <dd>
                <Assignment
                  item={item}
                  members={members}
                  self={self}
                  role={role}
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
          <RecordLinks organizationId={organizationId} item={item} />
        </section>
      </div>
      <section className="decision-review" aria-labelledby={`${id}-review`}>
        <h3 id={`${id}-review`}>Review and respond</h3>
        <p className="decision-note">
          These are the same controls shown on the{' '}
          {item.owner.kind === 'case'
            ? 'issue'
            : item.owner.kind === 'workflow_run'
              ? 'workflow run'
              : 'record'}
          . They check the exact proposal, its revision and its expiry again
          before anything changes.
        </p>
        {review}
      </section>
    </article>
  );
}
