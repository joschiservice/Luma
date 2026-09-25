import type {
  CaseSummary,
  OperationsOverview as Summary,
} from '@luma/api-contract';
import {
  ChevronRight,
  CircleCheck,
  Clock3,
  Gauge,
  ListChecks,
  Network,
  Plug,
  RefreshCw,
  Zap,
} from 'lucide-react';
import type { ReactNode } from 'react';

import { CaseLoading, CaseNotice } from '../issues/case-investigation';
import { Alert } from '../primitives/alert';
import { Badge } from '../primitives/badge';
import { Button } from '../primitives/button';
import { Card, CardHeader } from '../primitives/card';
import { Select } from '../primitives/select';

export interface OperationsOverviewProps {
  data?: Summary | undefined;
  loading?: boolean;
  paused?: boolean;
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

/** Classifies an operations summary into the presentation state used by the overview. */
export function overviewState(data: Summary): {
  title: string;
  tone: 'info' | 'warning' | 'success';
  description: string;
} {
  if (!data.connections.length)
    return {
      title: 'Connect your first system.',
      tone: 'info',
      description:
        'Start with Shopify or JTL-Wawi. Observations will bring your operations into view.',
    };
  const monitored = data.connections.filter((c) => c.status !== 'disconnected');
  if (!monitored.length)
    return {
      title: 'No connected systems.',
      tone: 'warning',
      description:
        'Your previous connections are disconnected. Connect a system to monitor operations again.',
    };
  if (monitored.some((c) => c.status !== 'active'))
    return {
      title: 'Check your connections.',
      tone: 'warning',
      description:
        'Some systems are not active. Review their connection status before relying on operational health.',
    };
  if (monitored.some((c) => c.freshness === 'unobserved'))
    return {
      title: 'Waiting for observations.',
      tone: 'info',
      description:
        'Health is unknown. At least one system has no observations for a permitted read capability.',
    };
  if (monitored.some((c) => c.freshness === 'stale'))
    return {
      title: 'Your data needs a refresh.',
      tone: 'warning',
      description:
        'Some observations are older than 24 hours. Current operational health is unknown.',
    };
  if (data.attentionCount)
    return {
      title: 'A few decisions need you.',
      tone: 'warning',
      description:
        'Review the highest-severity issues first. Each investigation includes evidence and a next step.',
    };
  if (data.activeCount)
    return {
      title: 'Work is still in progress.',
      tone: 'info',
      description:
        'No decisions currently need you. Active issues are still being investigated or resolved.',
    };

  return {
    title: 'Observed operations look healthy.',
    tone: 'success',
    description:
      'Monitored connections have recent observations and no active issues are recorded. Source coverage may still be incomplete.',
  };
}

/**
 * Presents operations counts, prioritized decisions, and connection freshness with caller-
 * provided navigation and refresh actions.
 */
export function OperationsOverview({
  data,
  loading,
  paused,
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
          <h1>Operations overview</h1>
          <p>Monitor connected systems and review what needs attention.</p>
        </div>
        <div className="operations-controls">
          <label>
            Resolution window
            <Select<'24h' | '7d'>
              aria-label="Resolution window"
              value={window}
              onValueChange={(value) => {
                if (value) onWindowChange(value);
              }}
              options={[
                { value: '24h', label: 'Last 24 hours' },
                { value: '7d', label: 'Last 7 days' },
              ]}
            />
          </label>
          <Button
            variant="outline"
            onClick={onRefresh}
            disabled={refreshing || paused}
          >
            <RefreshCw size={14} aria-hidden="true" />{' '}
            {error ? 'Retry' : 'Refresh'}
          </Button>
        </div>
      </header>
      {paused ? (
        <CaseNotice title="Updates paused while offline">
          Current health and totals are unavailable. Reconnect to refresh the
          overview automatically.
        </CaseNotice>
      ) : loading ? (
        <CaseLoading />
      ) : error ? (
        <CaseNotice error title="Operations overview unavailable">
          Current health and totals could not be confirmed. Retry to load
          authoritative data.
        </CaseNotice>
      ) : data && state ? (
        <>
          <Alert
            tone={state.tone}
            role="region"
            aria-label="Operational health"
            className="operations-status"
          >
            <h2>{state.title}</h2>
            <p>{state.description}</p>
            {connectionsLink}
          </Alert>
          <p className="operations-asof">
            <Clock3 size={12} aria-hidden="true" /> As of{' '}
            <time dateTime={data.generatedAt}>
              {timestamp(data.generatedAt)}
            </time>
            . Updates every 30 seconds.
          </p>
          <section
            aria-label="Operational metrics"
            className="operations-metrics"
          >
            <Card as="div">
              <ListChecks
                className="operations-metric-icon"
                size={28}
                aria-hidden="true"
              />
              <p className="operations-eyebrow">Needs your attention</p>
              <strong>{data.attentionCount}</strong>
              <p>Decisions requiring attention</p>
              {inboxLink}
            </Card>
            <Card as="div">
              <Zap
                className="operations-metric-icon"
                size={28}
                aria-hidden="true"
              />
              <p className="operations-eyebrow">Resolved automatically</p>
              <strong>{data.automaticallyResolved ?? 'Unavailable'}</strong>
              <p>
                {data.automaticallyResolved === null
                  ? 'Human-work attribution is not available.'
                  : 'Verified without human work in this window.'}
              </p>
              <small>
                {data.verifiedResolutions} verified resolutions in this window,
                including issues with human work.
              </small>
            </Card>
            <Card as="div">
              <Gauge
                className="operations-metric-icon"
                size={28}
                aria-hidden="true"
              />
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
                  ? `${data.automation.numerator} / ${data.automation.denominator} eligible issues resolved correctly without human work.`
                  : 'Eligibility and human-work data are not available.'}
              </p>
              {data.automation?.denominator === 0 ? (
                <small>No eligible issues in this window.</small>
              ) : null}
            </Card>
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
            <Card as="section" aria-labelledby="overview-decisions">
              <CardHeader className="operations-section-heading">
                <h2 id="overview-decisions">
                  <ListChecks size={17} aria-hidden="true" /> Your next
                  decisions
                </h2>
                <span>Severity, then oldest request</span>
              </CardHeader>
              {data.prioritizedDecisions.length ? (
                <ol className="operations-decisions">
                  {data.prioritizedDecisions.map((item) => (
                    <li key={item.id}>
                      <div className="operations-decision-title">
                        {decisionLink(item)}
                        <ChevronRight size={15} aria-hidden="true" />
                      </div>
                      <p>
                        <Badge
                          tone={
                            item.severity === 'high' ? 'warning' : 'neutral'
                          }
                        >
                          {item.severity} severity
                        </Badge>{' '}
                        · {item.attention.explanation}
                      </p>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="operations-empty">
                  <CircleCheck size={18} aria-hidden="true" />
                  No decisions currently require attention. {
                    data.activeCount
                  }{' '}
                  active issues remain.
                </p>
              )}
              {inboxLink}
            </Card>
            <Card as="section" aria-labelledby="overview-connections">
              <CardHeader className="operations-section-heading">
                <h2 id="overview-connections">
                  <Network size={17} aria-hidden="true" /> Connection health
                </h2>
              </CardHeader>
              {data.connections.length ? (
                <ul className="operations-connections">
                  {data.connections.map((c) => (
                    <li
                      key={c.id}
                      data-health={
                        c.status === 'disconnected'
                          ? 'inactive'
                          : c.status === 'active' && c.freshness === 'fresh'
                            ? 'fresh'
                            : 'attention'
                      }
                    >
                      <div>
                        <strong>
                          <Plug size={15} aria-hidden="true" />
                          {c.label}
                        </strong>
                        <span>
                          {c.status} ·{' '}
                          {c.status === 'disconnected'
                            ? 'Not monitored'
                            : c.freshness === 'unobserved'
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
            </Card>
          </div>
        </>
      ) : null}
    </div>
  );
}
