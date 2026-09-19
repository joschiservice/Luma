import type { ReactNode } from 'react';
import type {
  OperationsOverview as Summary,
  CaseSummary,
} from '@luma/api-contract';
import { Button } from './button';
import { CaseLoading, CaseNotice } from './case-investigation';

export interface OperationsOverviewProps {
  data?: Summary | undefined;
  loading?: boolean;
  error?: boolean;
  refreshing?: boolean;
  window: '24h' | '7d';
  onWindowChange: (value: '24h' | '7d') => void;
  onRefresh: () => void;
  connectionsLink: ReactNode;
  inboxLink: ReactNode;
  decisionLink: (item: CaseSummary) => ReactNode;
}
function timestamp(value: string) {
  return value.replace('T', ' ').slice(0, 16) + ' UTC';
}
export function overviewState(data: Summary) {
  if (!data.connections.length)
    return {
      title: 'Connect your first system.',
      description:
        'Start with Shopify or JTL-Wawi. Observations will bring your operations into view.',
    };
  if (data.connections.some((c) => c.status !== 'active'))
    return {
      title: 'Check your connections.',
      description:
        'Some systems are not active. Review their connection status before relying on operational health.',
    };
  if (data.connections.some((c) => c.freshness === 'unobserved'))
    return {
      title: 'Waiting for observations.',
      description:
        'Health is unknown. At least one system has no observations for a permitted read capability.',
    };
  if (data.connections.some((c) => c.freshness === 'stale'))
    return {
      title: 'Your data needs a refresh.',
      description:
        'Some observations are older than 24 hours. Current operational health is unknown.',
    };
  if (data.attentionCount)
    return {
      title: 'A few decisions need you.',
      description:
        'Review the highest-severity cases first. Each investigation includes evidence and a next step.',
    };
  if (data.activeCount)
    return {
      title: 'Work is still in progress.',
      description:
        'No decisions currently need you. Active cases are still being investigated or resolved.',
    };
  return {
    title: 'Observed operations look healthy.',
    description:
      'Connections have recent observations and no active cases are recorded. Source coverage may still be incomplete.',
  };
}
export function OperationsOverview({
  data,
  loading,
  error,
  refreshing,
  window,
  onWindowChange,
  onRefresh,
  connectionsLink,
  inboxLink,
  decisionLink,
}: OperationsOverviewProps) {
  const state = data ? overviewState(data) : undefined;
  return (
    <div className="operations-overview">
      <header className="operations-heading">
        <div>
          <p className="operations-eyebrow">Exception Desk / Overview</p>
          <h1>Room to focus.</h1>
          <p>The state of your operations. The decisions that need you.</p>
        </div>
        <div className="operations-controls">
          <label>
            Resolution window
            <select
              value={window}
              onChange={(e) => onWindowChange(e.target.value as '24h' | '7d')}
            >
              <option value="24h">Last 24 hours</option>
              <option value="7d">Last 7 days</option>
            </select>
          </label>
          <Button variant="outline" onClick={onRefresh} disabled={refreshing}>
            {error ? 'Retry' : 'Refresh'}
          </Button>
        </div>
      </header>
      {loading ? (
        <CaseLoading />
      ) : error ? (
        <CaseNotice error title="Operations overview unavailable">
          Current health and totals could not be confirmed. Retry to load
          authoritative data.
        </CaseNotice>
      ) : data && state ? (
        <>
          <section
            className="operations-status"
            aria-label="Operational health"
          >
            <span className="operations-status-mark" aria-hidden="true">
              ◉
            </span>
            <div>
              <h2>{state.title}</h2>
              <p>{state.description}</p>
              {connectionsLink}
            </div>
          </section>
          <p className="operations-asof">
            As of{' '}
            <time dateTime={data.generatedAt}>
              {timestamp(data.generatedAt)}
            </time>
            . Updates every 30 seconds.
          </p>
          <section
            aria-label="Operational metrics"
            className="operations-metrics"
          >
            <div>
              <p className="operations-eyebrow">Needs you · now</p>
              <strong>{data.attentionCount}</strong>
              <p>Decisions requiring attention</p>
              {inboxLink}
            </div>
            <div>
              <p className="operations-eyebrow">Resolved automatically</p>
              <strong>{data.automaticallyResolved ?? 'Unavailable'}</strong>
              <p>
                {data.automaticallyResolved === null
                  ? 'Human-work attribution is not available.'
                  : 'Verified without human work in this window.'}
              </p>
              <small>
                {data.verifiedResolutions} verified resolutions in this window,
                including cases with human work.
              </small>
            </div>
            <div>
              <p className="operations-eyebrow">Eligible automation rate</p>
              <strong>
                {data.automation && data.automation.denominator > 0
                  ? `${Math.round((data.automation.numerator / data.automation.denominator) * 100)}%`
                  : data.automation
                    ? '—'
                    : 'Unavailable'}
              </strong>
              <p>
                {data.automation
                  ? `${data.automation.numerator} / ${data.automation.denominator} eligible exceptions resolved correctly without human work.`
                  : 'Eligibility and human-work data are not available.'}
              </p>
              {data.automation?.denominator === 0 ? (
                <small>No eligible exceptions in this window.</small>
              ) : null}
            </div>
          </section>
          <p className="operations-window">
            Resolution window:{' '}
            <time dateTime={data.window.start}>
              {timestamp(data.window.start)}
            </time>{' '}
            –{' '}
            <time dateTime={data.window.end}>{timestamp(data.window.end)}</time>
            . Attention and connection health describe the current state.
          </p>
          <div className="operations-details">
            <section aria-labelledby="overview-decisions">
              <div className="operations-section-heading">
                <h2 id="overview-decisions">Your next decisions</h2>
                <span>Severity, then oldest request</span>
              </div>
              {data.prioritizedDecisions.length ? (
                <ol className="operations-decisions">
                  {data.prioritizedDecisions.map((item) => (
                    <li key={item.id}>
                      {decisionLink(item)}
                      <p>
                        <span className="operations-severity">
                          {item.severity} severity
                        </span>{' '}
                        · {item.attention.explanation}
                      </p>
                    </li>
                  ))}
                </ol>
              ) : (
                <p>
                  No decisions currently require attention. {data.activeCount}{' '}
                  active cases remain.
                </p>
              )}
              {inboxLink}
            </section>
            <section aria-labelledby="overview-connections">
              <div className="operations-section-heading">
                <h2 id="overview-connections">Connection health</h2>
              </div>
              {data.connections.length ? (
                <ul className="operations-connections">
                  {data.connections.map((c) => (
                    <li key={c.id}>
                      <div>
                        <strong>{c.label}</strong>
                        <span>
                          {c.status} ·{' '}
                          {c.freshness === 'unobserved'
                            ? 'Missing observations'
                            : c.freshness === 'stale'
                              ? 'Stale data'
                              : 'Recent observations'}
                        </span>
                      </div>
                      <small>
                        {c.lastObservedAt
                          ? `Latest observation: ${timestamp(c.lastObservedAt)}`
                          : 'No observations yet'}
                      </small>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>
                  No connected systems. Add a connection, validate access, then
                  wait for observations.
                </p>
              )}
              <p className="operations-footnote">
                Freshness requires observations within{' '}
                {data.freshnessThresholdHours} hours for each granted read
                capability. It does not prove a complete source scan.
              </p>
              {connectionsLink}
            </section>
          </div>
        </>
      ) : null}
    </div>
  );
}
