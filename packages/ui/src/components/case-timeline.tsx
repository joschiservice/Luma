import type {
  CaseEvidencePage,
  CaseProgress,
  CaseReview,
  CaseTimelinePage,
} from '@luma/api-contract';
import type { ReactNode } from 'react';

import { Button } from './button';
import { caseLabel, CaseNotice, CaseTime } from './case-investigation';

export type LiveConnection = 'connecting' | 'syncing' | 'live' | 'disconnected';

type Event = CaseTimelinePage['items'][number];

const eventNames: Record<string, string> = {
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
  progress,
  review,
  timeline,
  evidence,
  connection,
  onRefresh,
  children,
}: {
  progress: CaseProgress;
  review: CaseReview;
  timeline: Event[];
  evidence: CaseEvidencePage['items'];
  connection: LiveConnection;
  onRefresh?: () => void;
  children?: ReactNode;
}) {
  const execution = progress.execution;
  const verification = execution?.verification;
  const proposal = review.proposal;
  const boundProposal =
    proposal && (!execution || proposal.id === execution.proposalId)
      ? proposal
      : null;
  const current = connection === 'live';
  const workflow = progress.workflow;

  return (
    <section
      className="case-progress"
      aria-label="Execution and audit timeline"
    >
      <header className="case-progress-heading">
        <h3>
          <span>05</span> Execution & verification
        </h3>
        <span className="case-live-status" role="status">
          {current
            ? 'Live'
            : connection === 'syncing'
              ? 'Refreshing'
              : connection === 'connecting'
                ? 'Connecting'
                : 'Connection lost'}
        </span>
      </header>
      {!current ? (
        <CaseNotice title="Current state is unconfirmed">
          {connection === 'disconnected'
            ? 'Reconnecting automatically. '
            : 'Reading authoritative progress. '}
          The records below show the last confirmed state.
        </CaseNotice>
      ) : null}
      <ol className="case-lifecycle" aria-label="Case lifecycle">
        {[
          ['detected'],
          ['diagnosed'],
          ['proposed'],
          ['awaiting_approval', 'allowed'],
          ['executing'],
          ['verifying'],
          ['resolved', 'escalated', 'failed'],
        ].map((states) => (
          <li
            key={states[0]}
            aria-current={states.includes(progress.state) ? 'step' : undefined}
          >
            {states.map(caseLabel).join(' / ')}
          </li>
        ))}
      </ol>
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
      <div className="case-outcomes">
        <div>
          <h4>Execution result</h4>
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
        <div>
          <h4>Verification result</h4>
          <strong>
            {verification ? caseLabel(verification.outcome) : 'Not recorded'}
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
      {boundProposal ? (
        <details className="case-evidence">
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
          <h4>Expected postcondition</h4>
          {Object.keys(boundProposal.expectedPostcondition).length ? (
            <dl>
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
        </details>
      ) : (
        <p>Verification criteria are not available for this attempt.</p>
      )}
      {execution ? (
        <details className="case-evidence">
          <summary>
            Attempt {execution.attempt} · {caseLabel(execution.state)}
          </summary>
          <dl>
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
          <h4>Effect evidence</h4>
          <References refs={execution.effectEvidenceRefs} />
          {verification ? (
            <>
              <h4>Observed result: {caseLabel(verification.outcome)}</h4>
              <p>
                <CaseTime value={verification.observedAt} /> · Evaluator{' '}
                {verification.evaluatorVersion}
              </p>
              <References refs={verification.observationRefs} />
              <p>
                Observation values are not included in this result. Inspect the
                evidence provenance below.
              </p>
            </>
          ) : null}
        </details>
      ) : null}
      {progress.resolution ? (
        <div className="case-resolution">
          <h4>
            {progress.resolution.kind === 'verification'
              ? 'Recorded verified resolution'
              : 'Closed by human disposition'}
          </h4>
          <p>
            {progress.resolution.kind === 'human_disposition'
              ? 'Human closure does not establish a verified correction. '
              : ''}
            <CaseTime value={progress.resolution.at} /> ·{' '}
            {progress.resolution.actorId}
          </p>
          <References refs={progress.resolution.evidenceRefs} />
        </div>
      ) : (
        <p>No canonical resolution recorded. The case remains unresolved.</p>
      )}
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
      <div className="case-progress-heading">
        <h4>Audit history</h4>
        {onRefresh ? (
          <Button variant="outline" onClick={onRefresh}>
            Refresh progress
          </Button>
        ) : null}
      </div>
      {timeline.length ? (
        <ol className="case-audit">
          {timeline.map((event) => (
            <li key={event.id}>
              <div>
                <strong>
                  {eventNames[event.type] ??
                    caseLabel(event.type.replaceAll('.', ' '))}
                </strong>
                <CaseTime value={event.occurredAt} />
              </div>
              {event.outcome ? (
                <p>Outcome: {caseLabel(event.outcome)}</p>
              ) : null}
              <p className="case-caption">
                Actor: {event.actorId ?? 'Not recorded'}
              </p>
              <details>
                <summary>Audit evidence</summary>
                <dl>
                  <dt>Event</dt>
                  <dd>{event.id}</dd>
                  <dt>Event type</dt>
                  <dd>{event.type}</dd>
                  {event.proposalId ? (
                    <>
                      <dt>Proposal</dt>
                      <dd>{event.proposalId}</dd>
                    </>
                  ) : null}
                </dl>
                <References refs={event.evidenceRefs} />
              </details>
            </li>
          ))}
        </ol>
      ) : (
        <p>No audit events recorded yet.</p>
      )}
      <h4>Evidence provenance</h4>
      {evidence.length ? (
        evidence.map((entry) => (
          <details className="case-evidence" key={entry.id}>
            <summary>
              {entry.source
                ? `${entry.source.provider} · ${entry.source.resource}`
                : 'Canonical evidence'}{' '}
              · {entry.id}
            </summary>
            <dl>
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
          </details>
        ))
      ) : (
        <p>
          No authorized observation references are available in this page. Audit
          references may describe other evidence types.
        </p>
      )}
      {children}
    </section>
  );
}
