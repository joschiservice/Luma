import type {
  CaseEvidencePage,
  CaseProgress,
  CaseReview,
  CaseTimelinePage,
} from '@luma/api-contract';
import { formatList } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { rich } from '@luma/i18n/rich';
import {
  Activity,
  CircleAlert,
  CircleCheck,
  ClipboardCheck,
  Clock3,
  Database,
  Flag,
  History,
  Play,
  RefreshCw,
  Search,
  ShieldCheck,
} from 'lucide-react';
import type { ReactNode } from 'react';

import { Button } from '../primitives/button';
import { Disclosure } from '../primitives/disclosure';
import { WorkspaceDate } from '../primitives/workspace-date';
import { caseLabel, CaseNotice, CaseTime } from './case-investigation';
import {
  caseStateLabel,
  decisionLabel,
  eventOutcomeLabel,
  executionStateLabel,
  recordKindLabel,
  verificationLabel,
  workflowStatusLabel,
} from './case-presentation';
import {
  ExecutionMetadata,
  executionStatus,
  ExecutionSummary,
} from './execution-summary';
import { IssueCollection } from './issue-collection';
import { EvidenceRecord, evidenceSourceLabel } from './issue-findings';
import { IssueSection } from './issue-section';

export type LiveConnection =
  'connecting' | 'syncing' | 'live' | 'disconnected' | 'interrupted';

type Event = CaseTimelinePage['items'][number];

type Execution = NonNullable<CaseProgress['execution']>;

const eventNames: Record<string, () => string> = {
  'exception.detected': m.issues_event_detected,
  'execution.prepared': m.issues_event_change_queued,
  'execution.completed': m.issues_event_change_finished,
  'execution.withheld': m.issues_event_change_withheld,
  'execution.reconciled': m.issues_event_change_reconciled,
  'case.approve': m.issues_event_approved,
  'case.reject': m.issues_event_rejected,
  'case.escalate': m.issues_event_escalated,
};

const executors = {
  service: m.issues_executor_service,
  agent: m.issues_executor_agent,
  connector: m.issues_executor_connector,
  user: m.issues_executor_user,
} satisfies Record<Execution['executor']['kind'], () => string>;

const policyOutcomes = {
  allowed: m.issues_policy_allowed,
  denied: m.issues_policy_denied,
  approval_required: m.issues_policy_approval_required,
} satisfies Record<
  NonNullable<NonNullable<CaseReview['proposal']>['policy']>['outcome'],
  () => string
>;

function eventName(type: string) {
  return eventNames[type]?.() ?? caseLabel(type.replaceAll('.', ' '));
}

function References({ refs }: { refs: string[] }) {
  return refs.length ? (
    <ul className="case-reference-list">
      {[...new Set(refs)].map((ref) => (
        <li key={ref}>{ref}</li>
      ))}
    </ul>
  ) : (
    <p>{m.issues_references_none()}</p>
  );
}

function countLabel(
  count: number,
  more: boolean,
  messages: {
    none: () => string;
    count: (inputs: { count: number }) => string;
    more: (inputs: { count: number }) => string;
  },
) {
  return more
    ? messages.more({ count })
    : count
      ? messages.count({ count })
      : messages.none();
}

/**
 * Displays the change, its outcome check, history events and evidence, with optional controls
 * for loading more history.
 */
export function CaseTimeline({
  expanded = false,
  progress,
  review,
  timeline,
  evidence,
  connection,
  confirmed = connection === 'live' ||
    connection === 'syncing' ||
    connection === 'interrupted',
  onRefresh,
  children,
  historyUnavailable = false,
  hasMoreTimeline = false,
  hasMoreEvidence = false,
  loadingHistory = false,
  onLoadMore,
}: {
  expanded?: boolean;
  progress: CaseProgress;
  review: CaseReview;
  timeline: Event[];
  evidence: CaseEvidencePage['items'];
  connection: LiveConnection;
  confirmed?: boolean;
  onRefresh?: () => void;
  children?: ReactNode;
  historyUnavailable?: boolean;
  hasMoreTimeline?: boolean;
  hasMoreEvidence?: boolean;
  loadingHistory?: boolean;
  onLoadMore?: (() => void) | undefined;
}) {
  const Subheading = expanded ? 'h3' : 'h4';
  const execution = progress.execution;
  const verification = execution?.verification;
  const proposal = review.proposal;
  const boundProposal =
    proposal && (!execution || proposal.id === execution.proposalId)
      ? proposal
      : null;
  const current = confirmed;

  const liveStatus = (
    <span
      className="case-live-status"
      data-live={connection === 'live'}
      role="status"
    >
      {connection === 'live'
        ? expanded
          ? m.issues_live_updates()
          : m.issues_live_short()
        : connection === 'syncing'
          ? m.common_refreshing()
          : connection === 'connecting'
            ? m.issues_live_connecting()
            : connection === 'interrupted'
              ? m.issues_live_interrupted()
              : m.issues_live_disconnected()}
    </span>
  );

  const stages = [
    {
      stage: 'investigation',
      states: ['detected', 'diagnosed'],
      label: m.issues_stage_investigation(),
      icon: Search,
      tone: 'investigation',
    },
    {
      stage: 'approval',
      states: ['proposed', 'awaiting_approval', 'allowed'],
      label: m.issues_stage_approval(),
      icon: ClipboardCheck,
      tone: 'review',
    },
    {
      stage: 'change',
      states: ['executing'],
      label: m.issues_stage_change(),
      icon: Play,
      tone: 'execution',
    },
    {
      stage: 'check',
      states: ['verifying'],
      label: m.issues_stage_check(),
      icon: ShieldCheck,
      tone: 'verification',
    },
    {
      stage: 'result',
      states: ['resolved', 'escalated', 'failed'],
      label: m.issues_stage_result(),
      icon:
        progress.state === 'failed' || progress.state === 'escalated'
          ? CircleAlert
          : progress.resolution?.kind === 'verification'
            ? CircleCheck
            : Flag,
      tone:
        progress.state === 'failed'
          ? 'failed'
          : progress.state === 'escalated'
            ? 'review'
            : progress.resolution?.kind === 'verification'
              ? 'resolved'
              : 'outcome',
    },
  ];

  return (
    <section
      className="case-progress recorded-findings"
      aria-label={m.issues_timeline_label()}
    >
      <IssueSection
        section="execution"
        preview={
          confirmed
            ? executionStatus(progress)
            : m.issues_state_unconfirmed_preview()
        }
        enabled={expanded}
        status={expanded ? liveStatus : undefined}
      >
        {!expanded && (
          <header className="case-progress-heading">
            {!expanded && (
              <h3>
                <Activity size={16} aria-hidden="true" />{' '}
                {m.issues_section_execution()}
              </h3>
            )}
            {liveStatus}
          </header>
        )}
        {!current ? (
          <CaseNotice title={m.issues_state_unconfirmed()}>
            {connection === 'disconnected'
              ? m.issues_state_unconfirmed_reconnecting()
              : m.issues_state_unconfirmed_loading()}
          </CaseNotice>
        ) : null}
        {expanded ? (
          <ExecutionSummary progress={progress} confirmed={current} />
        ) : (
          <>
            <ol className="case-lifecycle" aria-label={m.issues_stage_list()}>
              {stages.map(({ stage, states, label, icon: Icon, tone }) => (
                <li
                  key={stage}
                  data-stage={tone}
                  aria-current={
                    states.includes(progress.state) ? 'step' : undefined
                  }
                >
                  <span className="lifecycle-node">
                    <Icon size={16} aria-hidden="true" />
                  </span>
                  <span>{label}</span>
                </li>
              ))}
            </ol>
            <div className="execution-state-card">
              <p className="case-progress-state">
                {rich(
                  current
                    ? m.issues_progress_state
                    : m.issues_progress_state_last_confirmed,
                  { state: <strong>{caseStateLabel(progress.state)}</strong> },
                )}
              </p>
              <p className="case-caption">
                {m.issues_progress_versions({
                  issue: progress.caseRevision,
                  investigation: progress.diagnosisRevision,
                })}
              </p>
              <p>
                {m.issues_progress_workflow({
                  status: workflowStatusLabel(progress.workflow),
                })}
              </p>
              {progress.workflow.progress?.reason ? (
                <p>{caseLabel(progress.workflow.progress.reason)}</p>
              ) : null}
            </div>
            <div className="case-outcomes">
              <div
                data-tone={
                  execution?.state === 'succeeded'
                    ? 'success'
                    : execution?.state === 'failed'
                      ? 'error'
                      : 'neutral'
                }
              >
                <Subheading>
                  <Play size={15} aria-hidden="true" />{' '}
                  {m.issues_execution_change_label()}
                </Subheading>
                <strong>
                  {execution
                    ? executionStateLabel(execution.state)
                    : m.issues_change_not_sent()}
                </strong>
                <p>{m.issues_change_accepted_note()}</p>
              </div>
              <div
                data-tone={
                  verification?.outcome === 'passed'
                    ? 'success'
                    : verification?.outcome === 'failed'
                      ? 'error'
                      : 'neutral'
                }
              >
                <Subheading>
                  <ShieldCheck size={15} aria-hidden="true" />{' '}
                  {m.issues_check_label()}
                </Subheading>
                <strong>
                  {verification
                    ? verificationLabel(verification.outcome)
                    : m.issues_check_none()}
                </strong>
                <p>
                  {verification?.outcome === 'passed'
                    ? m.issues_check_confirmed_note()
                    : verification?.outcome === 'failed'
                      ? m.issues_check_not_confirmed_note()
                      : m.issues_check_pending_note()}
                </p>
              </div>
            </div>
          </>
        )}
        {boundProposal ? (
          <Disclosure className="case-evidence">
            <summary>{m.issues_criteria_title()}</summary>
            <dl>
              <dt>{m.issues_criteria_proposal()}</dt>
              <dd>
                {m.issues_criteria_proposal_value({
                  id: boundProposal.id,
                  version: boundProposal.version,
                })}
              </dd>
              <dt>{m.issues_execution_change_label()}</dt>
              <dd>
                {caseLabel(
                  boundProposal.capability
                    .replaceAll('.', ' ')
                    .replace(/([a-z])([A-Z])/g, '$1 $2'),
                )}
              </dd>
              <dt>{m.issues_criteria_connection()}</dt>
              <dd>{boundProposal.connectionId}</dd>
              <dt>{m.issues_criteria_target()}</dt>
              <dd>
                {recordKindLabel(boundProposal.target.kind)} ·{' '}
                {boundProposal.target.id}
              </dd>
              <dt>{m.issues_criteria_requested_by()}</dt>
              <dd>{boundProposal.requestedBy}</dd>
            </dl>
            <Subheading>{m.issues_criteria_expected()}</Subheading>
            {Object.keys(boundProposal.expectedPostcondition).length ? (
              <dl className="execution-criteria">
                {Object.entries(boundProposal.expectedPostcondition).map(
                  ([key, value]) => (
                    <div key={key}>
                      <dt>{caseLabel(key)}</dt>
                      <dd>
                        {value === null ? m.common_unknown() : String(value)}
                      </dd>
                    </div>
                  ),
                )}
              </dl>
            ) : (
              <p>{m.issues_criteria_expected_none()}</p>
            )}
            {boundProposal.policy ? (
              <p>
                {m.issues_criteria_rules({
                  outcome: policyOutcomes[boundProposal.policy.outcome](),
                })}
              </p>
            ) : null}
            {boundProposal.approval ? (
              <p>
                {rich(
                  boundProposal.approval.outcome === 'approved'
                    ? m.issues_criteria_approved_by
                    : m.issues_criteria_rejected_by,
                  {
                    actor: boundProposal.approval.actorId,
                    time: <CaseTime value={boundProposal.approval.createdAt} />,
                  },
                )}
              </p>
            ) : null}
          </Disclosure>
        ) : execution || !expanded ? (
          <p>{m.issues_criteria_unavailable()}</p>
        ) : null}
        {execution ? (
          <Disclosure className="case-evidence">
            <summary>
              {expanded
                ? m.issues_execution_details()
                : m.issues_execution_attempt_summary({
                    attempt: execution.attempt,
                    state: executionStateLabel(execution.state),
                  })}
            </summary>
            {expanded ? <ExecutionMetadata progress={progress} /> : null}
            <dl>
              <dt>{m.issues_execution_attempt()}</dt>
              <dd>{execution.attempt}</dd>
              <dt>{m.issues_execution_attempt_id()}</dt>
              <dd>{execution.attemptId}</dd>
              <dt>{m.issues_execution_change_id()}</dt>
              <dd>{execution.id}</dd>
              <dt>{m.issues_criteria_proposal()}</dt>
              <dd>{execution.proposalId}</dd>
              <dt>{m.issues_criteria_requested_by()}</dt>
              <dd>{execution.requestedBy}</dd>
              <dt>{m.issues_execution_sent_by()}</dt>
              <dd>
                {executors[execution.executor.kind]()} · {execution.executor.id}
              </dd>
              <dt>{m.issues_execution_started()}</dt>
              <dd>
                <CaseTime value={execution.startedAt} />
              </dd>
              <dt>{m.issues_execution_finished()}</dt>
              <dd>
                {execution.finishedAt ? (
                  <CaseTime value={execution.finishedAt} />
                ) : (
                  m.issues_not_recorded()
                )}
              </dd>
            </dl>
            {execution.state === 'unknown' ? (
              <p>{m.issues_execution_unclear_help()}</p>
            ) : null}
            <Subheading>{m.issues_execution_effect_evidence()}</Subheading>
            <References refs={execution.effectEvidenceRefs} />
            {verification ? (
              <>
                <Subheading>
                  {m.issues_check_result({
                    outcome: verificationLabel(verification.outcome),
                  })}
                </Subheading>
                <p>
                  {rich(m.issues_check_result_meta, {
                    time: <CaseTime value={verification.observedAt} />,
                    version: verification.evaluatorVersion,
                  })}
                </p>
                <References refs={verification.observationRefs} />
                <p>{m.issues_check_values_hidden()}</p>
              </>
            ) : null}
          </Disclosure>
        ) : expanded ? (
          <Disclosure className="case-evidence">
            <summary>{m.issues_execution_details()}</summary>
            <ExecutionMetadata progress={progress} />
          </Disclosure>
        ) : null}
        {progress.resolution ? (
          <div className="case-resolution">
            <Subheading>
              {progress.resolution.kind === 'verification'
                ? m.issues_resolution_verified_heading()
                : m.issues_resolution_human_title()}
            </Subheading>
            <p>
              {rich(
                progress.resolution.kind === 'human_disposition'
                  ? m.issues_resolution_human_meta
                  : m.issues_resolution_meta,
                {
                  time: <CaseTime value={progress.resolution.at} />,
                  actor: progress.resolution.actorId,
                },
              )}
            </p>
            <References refs={progress.resolution.evidenceRefs} />
          </div>
        ) : !expanded ? (
          <p className="case-caption">{m.issues_resolution_open()}</p>
        ) : null}
        {['failed', 'escalated'].includes(progress.state) ? (
          <CaseNotice title={m.issues_next_steps_title()}>
            {current && review.permittedDecisions.length
              ? m.issues_next_steps_with_decisions({
                  decisions: formatList(
                    review.permittedDecisions.map(decisionLabel),
                  ),
                })
              : m.issues_next_steps_without_decisions()}
          </CaseNotice>
        ) : null}
      </IssueSection>
      <IssueSection
        section="history"
        preview={
          historyUnavailable
            ? loadingHistory
              ? m.issues_history_loading()
              : m.issues_history_unavailable_short()
            : countLabel(timeline.length, hasMoreTimeline, {
                none: m.issues_history_count_none,
                count: m.issues_history_count,
                more: m.issues_history_count_more,
              })
        }
        enabled={expanded}
        status={
          expanded && onRefresh ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={onRefresh}
              disabled={loadingHistory}
            >
              <RefreshCw size={14} aria-hidden="true" />{' '}
              {m.issues_history_refresh()}
            </Button>
          ) : undefined
        }
      >
        <div
          className="case-progress-heading"
          data-issue-section={expanded ? undefined : 'history'}
          tabIndex={-1}
        >
          {!expanded && (
            <Subheading>
              <History size={16} aria-hidden="true" />{' '}
              {m.issues_section_history()}
            </Subheading>
          )}
          {!expanded && onRefresh ? (
            <Button variant="outline" onClick={onRefresh}>
              <RefreshCw size={14} aria-hidden="true" />{' '}
              {m.issues_progress_refresh()}
            </Button>
          ) : null}
        </div>
        {timeline.length ? (
          <p className="case-caption">{m.issues_newest_first()}</p>
        ) : null}
        <IssueCollection
          title={m.issues_section_history()}
          triggerLabel={
            hasMoreTimeline
              ? m.issues_history_view_full()
              : m.issues_history_view_full_count({ count: timeline.length })
          }
          noun="events"
          items={[...timeline].sort((a, b) =>
            b.occurredAt.localeCompare(a.occurredAt),
          )}
          hasMore={hasMoreTimeline}
          loading={loadingHistory}
          onLoadMore={onLoadMore}
          notice={children}
          filters={[
            {
              label: m.issues_history_filter_type(),
              value: (event) => eventName(event.type),
            },
            {
              label: m.issues_history_filter_outcome(),
              value: (event) =>
                event.outcome
                  ? eventOutcomeLabel(event.outcome)
                  : m.issues_not_recorded(),
            },
          ]}
          renderItems={(events) =>
            events.length ? (
              <ol className={`case-audit${expanded ? ' audit-compact' : ''}`}>
                {events.map((event) => (
                  <li key={event.id}>
                    <span className="audit-event-icon" aria-hidden="true">
                      {event.outcome === 'failed' ||
                      event.type === 'execution.withheld' ? (
                        <CircleAlert size={14} />
                      ) : event.outcome === 'succeeded' ||
                        event.type === 'execution.reconciled' ? (
                        <CircleCheck size={14} />
                      ) : (
                        <Clock3 size={14} />
                      )}
                    </span>
                    <div className="audit-event-heading">
                      <strong>{eventName(event.type)}</strong>
                      <WorkspaceDate value={event.occurredAt} />
                    </div>
                    {event.outcome ? (
                      <p
                        className="audit-outcome"
                        data-tone={
                          event.outcome === 'succeeded'
                            ? 'success'
                            : event.outcome === 'failed'
                              ? 'error'
                              : 'neutral'
                        }
                      >
                        {eventOutcomeLabel(event.outcome)}
                      </p>
                    ) : null}
                    {event.actorId ? (
                      <p className="case-caption audit-actor">
                        {m.issues_history_by({ actor: event.actorId })}
                      </p>
                    ) : null}
                    <Disclosure className="audit-event-details">
                      <summary>{m.issues_history_event_details()}</summary>
                      <dl>
                        <dt>{m.issues_history_event_id()}</dt>
                        <dd>{event.id}</dd>
                        <dt>{m.issues_history_filter_type()}</dt>
                        <dd>{event.type}</dd>
                        <dt>{m.issues_history_recorded_at()}</dt>
                        <dd>
                          <time dateTime={event.occurredAt}>
                            {event.occurredAt}
                          </time>
                        </dd>
                        <dt>{m.issues_history_actor()}</dt>
                        <dd>{event.actorId ?? m.issues_not_recorded()}</dd>
                        {event.proposalId ? (
                          <>
                            <dt>{m.issues_criteria_proposal()}</dt>
                            <dd>{event.proposalId}</dd>
                          </>
                        ) : null}
                      </dl>
                      <References refs={event.evidenceRefs} />
                    </Disclosure>
                  </li>
                ))}
              </ol>
            ) : (
              <p>
                {historyUnavailable
                  ? m.issues_history_unavailable()
                  : m.issues_history_empty()}
              </p>
            )
          }
        />
      </IssueSection>
      <IssueSection
        section="evidence"
        enabled={expanded}
        preview={
          historyUnavailable
            ? m.issues_evidence_unavailable_short()
            : countLabel(evidence.length, hasMoreEvidence, {
                none: m.issues_evidence_count_none,
                count: m.issues_evidence_count,
                more: m.issues_evidence_count_more,
              })
        }
      >
        {!expanded && (
          <Subheading
            className="execution-evidence-heading"
            data-issue-section={expanded ? undefined : 'evidence'}
            tabIndex={-1}
          >
            <Database size={16} aria-hidden="true" />{' '}
            {m.issues_section_evidence()}
          </Subheading>
        )}
        <IssueCollection
          title={m.issues_section_evidence()}
          noun="evidence"
          items={[...evidence].sort((a, b) =>
            b.observedAt.localeCompare(a.observedAt),
          )}
          hasMore={hasMoreEvidence}
          loading={loadingHistory}
          onLoadMore={onLoadMore}
          notice={children}
          filters={[{ label: m.common_source(), value: evidenceSourceLabel }]}
          renderItems={(entries) =>
            entries.length ? (
              entries.map((entry) => (
                <EvidenceRecord key={entry.id} entry={entry} />
              ))
            ) : (
              <p>
                {historyUnavailable
                  ? m.issues_evidence_unavailable()
                  : m.issues_evidence_empty_page()}
              </p>
            )
          }
        />
        {children}
      </IssueSection>
    </section>
  );
}
