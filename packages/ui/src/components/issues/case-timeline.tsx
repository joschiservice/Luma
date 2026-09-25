import type {
  CaseEvidencePage,
  CaseProgress,
  CaseReview,
  CaseTimelinePage,
} from '@luma/api-contract';
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
import { caseLabel, CaseNotice, CaseTime } from './case-investigation';
import {
  ExecutionMetadata,
  executionStatus,
  ExecutionSummary,
} from './execution-summary';
import { IssueCollection } from './issue-collection';
import { IssueSection } from './issue-section';

export type LiveConnection =
  'connecting' | 'syncing' | 'live' | 'disconnected' | 'interrupted';

type Event = CaseTimelinePage['items'][number];

const eventNames: Record<string, string> = {
  'exception.detected': 'Issue detected',
  'execution.prepared': 'Execution reserved',
  'execution.completed': 'Execution attempt finished',
  'execution.withheld': 'Execution withheld',
  'execution.reconciled': 'Recovery confirmed by observation',
  'case.approve': 'Operator approved',
  'case.reject': 'Operator rejected',
  'case.escalate': 'Operator escalated',
};

function References({ refs }: { refs: string[] }) {
  return refs.length ? (
    <ul className="case-reference-list">
      {[...new Set(refs)].map((ref) => (
        <li key={ref}>{ref}</li>
      ))}
    </ul>
  ) : (
    <p>No evidence references recorded.</p>
  );
}

/**
 * Displays execution progress, audit events, and evidence with optional controls for loading
 * more history.
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
  const workflow = progress.workflow;

  const liveStatus = (
    <span
      className="case-live-status"
      data-live={connection === 'live'}
      role="status"
    >
      {connection === 'live'
        ? expanded
          ? 'Live updates'
          : 'Live'
        : connection === 'syncing'
          ? 'Refreshing'
          : connection === 'connecting'
            ? 'Connecting'
            : connection === 'interrupted'
              ? 'Live updates interrupted'
              : 'Connection lost'}
    </span>
  );

  return (
    <section
      className="case-progress recorded-findings"
      aria-label="Execution and audit timeline"
    >
      <IssueSection
        section="execution"
        preview={
          confirmed ? executionStatus(progress) : 'Current state unconfirmed'
        }
        enabled={expanded}
        status={expanded ? liveStatus : undefined}
      >
        {!expanded && (
          <header className="case-progress-heading">
            {!expanded && (
              <h3>
                <Activity size={16} aria-hidden="true" /> Execution &
                verification
              </h3>
            )}
            {liveStatus}
          </header>
        )}
        {!current ? (
          <CaseNotice title="Current state is unconfirmed">
            {connection === 'disconnected'
              ? 'Reconnecting automatically. '
              : 'Reading authoritative progress. '}
            The records below show the last confirmed state.
          </CaseNotice>
        ) : null}
        {expanded ? (
          <ExecutionSummary progress={progress} confirmed={current} />
        ) : (
          <>
            <ol className="case-lifecycle" aria-label="Case lifecycle">
              {[
                {
                  states: ['detected', 'diagnosed'],
                  label: 'Investigation',
                  icon: Search,
                  tone: 'investigation',
                },
                {
                  states: ['proposed', 'awaiting_approval', 'allowed'],
                  label: 'Review',
                  icon: ClipboardCheck,
                  tone: 'review',
                },
                {
                  states: ['executing'],
                  label: 'Execution',
                  icon: Play,
                  tone: 'execution',
                },
                {
                  states: ['verifying'],
                  label: 'Verification',
                  icon: ShieldCheck,
                  tone: 'verification',
                },
                {
                  states: ['resolved', 'escalated', 'failed'],
                  label: 'Outcome',
                  icon:
                    progress.state === 'failed' ||
                    progress.state === 'escalated'
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
              ].map(({ states, label, icon: Icon, tone }) => (
                <li
                  key={label}
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
                {current ? 'Case state' : 'Last confirmed case state'}:{' '}
                <strong>{caseLabel(progress.state)}</strong>
              </p>
              <p className="case-caption">
                Case revision {progress.caseRevision} · Investigation revision{' '}
                {progress.diagnosisRevision}
              </p>
              <p>
                Workflow:{' '}
                {workflow.availability === 'unavailable'
                  ? 'Unavailable. Current activity is unknown.'
                  : workflow.availability === 'not_started'
                    ? 'Not started'
                    : workflow.progress
                      ? caseLabel(workflow.progress.phase)
                      : 'Current phase unknown'}
              </p>
              {workflow.progress?.reason ? (
                <p>{caseLabel(workflow.progress.reason)}</p>
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
                  <Play size={15} aria-hidden="true" /> Execution result
                </Subheading>
                <strong>
                  {execution
                    ? {
                        prepared: 'Reserved; result pending',
                        unknown: 'Effect unknown',
                        succeeded: 'Succeeded',
                        failed: 'Failed',
                      }[execution.state]
                    : 'No attempt recorded'}
                </strong>
                <p>A successful action alone does not establish resolution.</p>
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
                  <ShieldCheck size={15} aria-hidden="true" /> Verification
                  result
                </Subheading>
                <strong>
                  {verification
                    ? caseLabel(verification.outcome)
                    : 'Not recorded'}
                </strong>
                <p>
                  {verification?.outcome === 'passed'
                    ? 'The recorded verification criteria passed.'
                    : verification?.outcome === 'failed'
                      ? 'The intended outcome was not confirmed.'
                      : 'The intended outcome remains uncertain.'}
                </p>
              </div>
            </div>
          </>
        )}
        {boundProposal ? (
          <Disclosure className="case-evidence">
            <summary>Action and verification criteria</summary>
            <dl>
              <dt>Proposal</dt>
              <dd>
                {boundProposal.id} · Version {boundProposal.version}
              </dd>
              <dt>Action</dt>
              <dd>
                {boundProposal.capability} · {boundProposal.capabilityVersion}
              </dd>
              <dt>Connection</dt>
              <dd>{boundProposal.connectionId}</dd>
              <dt>Target</dt>
              <dd>
                {boundProposal.target.kind} · {boundProposal.target.id}
              </dd>
              <dt>Requested by</dt>
              <dd>{boundProposal.requestedBy}</dd>
            </dl>
            <Subheading>Expected outcome</Subheading>
            {Object.keys(boundProposal.expectedPostcondition).length ? (
              <dl className="execution-criteria">
                {Object.entries(boundProposal.expectedPostcondition).map(
                  ([key, value]) => (
                    <div key={key}>
                      <dt>{caseLabel(key)}</dt>
                      <dd>{value === null ? 'Unknown' : String(value)}</dd>
                    </div>
                  ),
                )}
              </dl>
            ) : (
              <p>No structured criteria recorded.</p>
            )}
            {boundProposal.policy ? (
              <p>
                Policy: {caseLabel(boundProposal.policy.outcome)} ·{' '}
                {boundProposal.policy.policyVersion}
              </p>
            ) : null}
            {boundProposal.approval ? (
              <p>
                {caseLabel(boundProposal.approval.outcome)} by{' '}
                {boundProposal.approval.actorId} ·{' '}
                <CaseTime value={boundProposal.approval.createdAt} />
              </p>
            ) : null}
          </Disclosure>
        ) : execution || !expanded ? (
          <p>Verification criteria are not available for this attempt.</p>
        ) : null}
        {execution ? (
          <Disclosure className="case-evidence">
            <summary>
              {expanded
                ? 'Execution details'
                : `Attempt ${execution.attempt} · ${caseLabel(execution.state)}`}
            </summary>
            {expanded ? <ExecutionMetadata progress={progress} /> : null}
            <dl>
              <dt>Attempt</dt>
              <dd>{execution.attempt}</dd>
              <dt>Attempt ID</dt>
              <dd>{execution.attemptId}</dd>
              <dt>Execution</dt>
              <dd>{execution.id}</dd>
              <dt>Proposal</dt>
              <dd>{execution.proposalId}</dd>
              <dt>Requested by</dt>
              <dd>{execution.requestedBy}</dd>
              <dt>Executor</dt>
              <dd>
                {execution.executor.kind} · {execution.executor.id}
              </dd>
              <dt>Started</dt>
              <dd>
                <CaseTime value={execution.startedAt} />
              </dd>
              <dt>Finished</dt>
              <dd>
                {execution.finishedAt ? (
                  <CaseTime value={execution.finishedAt} />
                ) : (
                  'Not recorded'
                )}
              </dd>
            </dl>
            {execution.state === 'unknown' ? (
              <p>
                The action may have taken effect. Inspect fresh observations
                before any further action.
              </p>
            ) : null}
            <Subheading>Effect evidence</Subheading>
            <References refs={execution.effectEvidenceRefs} />
            {verification ? (
              <>
                <Subheading>
                  Observed result: {caseLabel(verification.outcome)}
                </Subheading>
                <p>
                  <CaseTime value={verification.observedAt} /> · Evaluator{' '}
                  {verification.evaluatorVersion}
                </p>
                <References refs={verification.observationRefs} />
                <p>
                  Observation values are not included in this result. Inspect
                  the evidence provenance below.
                </p>
              </>
            ) : null}
          </Disclosure>
        ) : expanded ? (
          <Disclosure className="case-evidence">
            <summary>Execution details</summary>
            <ExecutionMetadata progress={progress} />
          </Disclosure>
        ) : null}
        {progress.resolution ? (
          <div className="case-resolution">
            <Subheading>
              {progress.resolution.kind === 'verification'
                ? 'Recorded verified resolution'
                : 'Closed by human disposition'}
            </Subheading>
            <p>
              {progress.resolution.kind === 'human_disposition'
                ? 'Human closure does not establish a verified correction. '
                : ''}
              <CaseTime value={progress.resolution.at} /> ·{' '}
              {progress.resolution.actorId}
            </p>
            <References refs={progress.resolution.evidenceRefs} />
          </div>
        ) : !expanded ? (
          <p className="case-caption">
            This issue is still open. No resolution has been recorded.
          </p>
        ) : null}
        {['failed', 'escalated'].includes(progress.state) ? (
          <CaseNotice title="Next steps">
            <span>
              Inspect the attempt and evidence, then follow the current
              investigation recommendation.{' '}
            </span>
            {current && review.permittedDecisions.length
              ? `Permitted decisions: ${review.permittedDecisions.map(caseLabel).join(', ')}. `
              : 'No decision is confirmed as available. '}
            Automatic retries are not available from this view.
          </CaseNotice>
        ) : null}
      </IssueSection>
      <IssueSection
        section="history"
        preview={
          historyUnavailable
            ? loadingHistory
              ? 'Loading history'
              : 'History unavailable'
            : `${timeline.length}${hasMoreTimeline ? '+' : ''} recorded ${timeline.length === 1 && !hasMoreTimeline ? 'event' : 'events'}`
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
              <RefreshCw size={14} aria-hidden="true" /> Refresh history
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
              <History size={16} aria-hidden="true" /> Audit history
            </Subheading>
          )}
          {!expanded && onRefresh ? (
            <Button variant="outline" onClick={onRefresh}>
              <RefreshCw size={14} aria-hidden="true" /> Refresh progress
            </Button>
          ) : null}
        </div>
        {timeline.length ? <p className="case-caption">Newest first</p> : null}
        <IssueCollection
          title="Audit history"
          triggerLabel={
            hasMoreTimeline
              ? 'View full history'
              : `View full history (${timeline.length})`
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
              label: 'Event type',
              value: (event) =>
                eventNames[event.type] ??
                caseLabel(event.type.replaceAll('.', ' ')),
            },
            {
              label: 'Outcome',
              value: (event) =>
                event.outcome ? caseLabel(event.outcome) : 'Not recorded',
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
                      <strong>
                        {eventNames[event.type] ??
                          caseLabel(event.type.replaceAll('.', ' '))}
                      </strong>
                      <time
                        dateTime={event.occurredAt}
                        title={event.occurredAt}
                      >
                        {new Date(event.occurredAt)
                          .toISOString()
                          .replace('T', ' ')
                          .slice(0, 19)}{' '}
                        UTC
                      </time>
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
                        {caseLabel(event.outcome)}
                      </p>
                    ) : null}
                    {event.actorId ? (
                      <p className="case-caption audit-actor">
                        By {event.actorId}
                      </p>
                    ) : null}
                    <Disclosure className="audit-event-details">
                      <summary>Event details</summary>
                      <dl>
                        <dt>Event</dt>
                        <dd>{event.id}</dd>
                        <dt>Event type</dt>
                        <dd>{event.type}</dd>
                        <dt>Recorded at</dt>
                        <dd>
                          <time dateTime={event.occurredAt}>
                            {event.occurredAt}
                          </time>
                        </dd>
                        <dt>Actor</dt>
                        <dd>{event.actorId ?? 'Not recorded'}</dd>
                        {event.proposalId ? (
                          <>
                            <dt>Proposal</dt>
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
                  ? 'Audit history is unavailable.'
                  : 'No audit events recorded yet.'}
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
            ? 'Evidence unavailable'
            : `${evidence.length}${hasMoreEvidence ? '+' : ''} ${evidence.length === 1 && !hasMoreEvidence ? 'record' : 'records'}`
        }
      >
        {!expanded && (
          <Subheading
            className="execution-evidence-heading"
            data-issue-section={expanded ? undefined : 'evidence'}
            tabIndex={-1}
          >
            <Database size={16} aria-hidden="true" /> Evidence provenance
          </Subheading>
        )}
        <IssueCollection
          title="Evidence provenance"
          noun="evidence records"
          items={[...evidence].sort((a, b) =>
            b.observedAt.localeCompare(a.observedAt),
          )}
          hasMore={hasMoreEvidence}
          loading={loadingHistory}
          onLoadMore={onLoadMore}
          notice={children}
          filters={[
            {
              label: 'Source',
              value: (entry) =>
                entry.source
                  ? `${entry.source.provider} · ${entry.source.resource}`
                  : 'Canonical evidence',
            },
          ]}
          renderItems={(entries) =>
            entries.length ? (
              entries.map((entry) => (
                <Disclosure className="case-evidence" key={entry.id}>
                  <summary>
                    {entry.source
                      ? `${entry.source.provider} · ${entry.source.resource}`
                      : 'Canonical evidence'}{' '}
                    <span>
                      Observed <CaseTime value={entry.observedAt} />
                    </span>
                  </summary>
                  <dl>
                    <dt>Evidence ID</dt>
                    <dd>{entry.id}</dd>
                    <dt>Observed</dt>
                    <dd>
                      <CaseTime value={entry.observedAt} />
                    </dd>
                    <dt>Source updated</dt>
                    <dd>
                      {entry.sourceUpdatedAt ? (
                        <CaseTime value={entry.sourceUpdatedAt} />
                      ) : (
                        'Unknown'
                      )}
                    </dd>
                    <dt>Completeness</dt>
                    <dd>{caseLabel(entry.completeness)}</dd>
                    <dt>Adapter / schema</dt>
                    <dd>
                      {entry.adapterVersion} / {entry.schemaVersion}
                    </dd>
                    {entry.source ? (
                      <>
                        <dt>Source object</dt>
                        <dd>{entry.source.externalId}</dd>
                        <dt>Source scope</dt>
                        <dd>{entry.source.scopeKey || 'Not specified'}</dd>
                      </>
                    ) : null}
                  </dl>
                </Disclosure>
              ))
            ) : (
              <p>
                {historyUnavailable
                  ? 'Evidence history is unavailable.'
                  : 'No authorized observation references are available in this page. Audit references may describe other evidence types.'}
              </p>
            )
          }
        />
        {children}
      </IssueSection>
    </section>
  );
}
