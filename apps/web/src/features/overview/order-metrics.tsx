import './order-metrics.css';

import type { MetricResponse } from '@luma/api-contract';
import {
  CaseLoading,
  CaseNotice,
} from '@luma/ui/components/issues/case-investigation';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import { Card } from '@luma/ui/components/primitives/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@luma/ui/components/primitives/dialog';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { Link, useLocation } from '@tanstack/react-router';
import {
  ArrowRight,
  Clock3,
  ListChecks,
  PackageOpen,
  RefreshCw,
} from 'lucide-react';
import { useRef, useState } from 'react';

import { IdentityError } from '../identity/data';
import { useLiveMetrics } from './metrics-live';

type Metric = MetricResponse['metrics'][number];

const icons = [PackageOpen, Clock3, ListChecks];

/** Presents source-aware order counts and lets operators inspect their exact matching records. */
export function OrderMetrics({ organizationId }: { organizationId: string }) {
  return (
    <LiveOrderMetrics key={organizationId} organizationId={organizationId} />
  );
}

function LiveOrderMetrics({ organizationId }: { organizationId: string }) {
  const location = useLocation();
  const restoredMetric = new URLSearchParams(location.searchStr).get('metric');
  const trigger = useRef<HTMLButtonElement>(null);
  const { query, request, setRequest, connection } =
    useLiveMetrics(organizationId);
  const [selected, setSelected] = useState(
    restoredMetric?.startsWith('orders.') ? restoredMetric : 'orders.open',
  );
  const [open, setOpen] = useState(
    Boolean(restoredMetric?.startsWith('orders.')),
  );
  const data =
    query.isError ||
    query.isPaused ||
    connection === 'denied' ||
    connection === 'offline'
      ? undefined
      : query.data;
  const metric = data?.metrics.find((m) => m.definition.id === selected);
  const conflict =
    query.error instanceof IdentityError && query.error.status === 409;
  const refresh = () => {
    if (request.snapshot) setRequest({});
    else void query.refetch();
  };

  return (
    <section className="order-metrics" aria-labelledby="order-metrics-title">
      <header className="order-metrics-heading">
        <div>
          <p className="order-metrics-eyebrow">Order operations</p>
          <h2 id="order-metrics-title">The work behind the numbers</h2>
          <p>One order, one count — across connected systems.</p>
        </div>
        <Button
          variant="outline"
          onClick={refresh}
          disabled={
            query.isFetching ||
            query.isPaused ||
            connection === 'offline' ||
            connection === 'denied'
          }
        >
          <RefreshCw size={14} />
          Refresh orders
        </Button>
      </header>
      <div
        className="order-metrics-provenance"
        role="status"
        aria-live="polite"
      >
        <Badge
          tone={
            (connection === 'live' || connection === 'syncing') &&
            !query.isError
              ? 'neutral'
              : 'warning'
          }
        >
          {connection === 'denied'
            ? 'Access changed'
            : query.isPaused || connection === 'offline'
              ? 'Offline'
              : query.isError
                ? 'Updates unavailable'
                : connection === 'live'
                  ? query.isFetching
                    ? 'Updating'
                    : 'Live updates'
                  : connection === 'syncing'
                    ? 'Updating'
                    : connection === 'connecting'
                      ? 'Connecting'
                      : 'Reconnecting'}
        </Badge>
        <span>
          {connection === 'denied'
            ? 'Your workspace access changed. Sign in again to continue.'
            : connection === 'reconnecting'
              ? 'Live updates interrupted. Rechecking current counts.'
              : 'Counts and matching orders update together.'}
        </span>
      </div>
      {connection === 'denied' ? null : query.isPaused ||
        connection === 'offline' ? (
        <CaseNotice title="Order updates paused">
          Reconnect to load current order counts.
        </CaseNotice>
      ) : query.isError ? (
        <CaseNotice
          error
          title={
            conflict
              ? 'The matching orders changed'
              : 'Order metrics unavailable'
          }
        >
          {conflict
            ? 'Refresh orders to inspect a new, consistent snapshot.'
            : 'Refresh orders to try again. Previous counts are hidden.'}
        </CaseNotice>
      ) : query.isPending ? (
        <CaseLoading />
      ) : data ? (
        <>
          <div className="order-metrics-grid">
            {data.metrics.map((item, index) => {
              const Icon = icons[index]!;

              return (
                <Card
                  as="div"
                  key={item.definition.id}
                  className="order-metric-card"
                >
                  <div className="order-metric-label">
                    <Icon size={18} aria-hidden="true" />
                    <h3>{item.definition.title}</h3>
                    <Badge tone="neutral">
                      {data.coverage === 'unavailable'
                        ? 'Unavailable'
                        : 'Partial'}
                    </Badge>
                  </div>
                  <div className="order-metric-value">
                    {data.coverage === 'unavailable'
                      ? '—'
                      : item.observedCount.toLocaleString()}
                    <span>
                      {data.coverage === 'unavailable'
                        ? 'Awaiting order observations'
                        : 'observed orders'}
                    </span>
                  </div>
                  <p>{item.definition.description}</p>
                  <Button
                    variant="ghost"
                    onClick={(event) => {
                      trigger.current = event.currentTarget;
                      setSelected(item.definition.id);
                      setOpen(true);
                    }}
                  >
                    Inspect orders & definition{' '}
                    <ArrowRight size={14} aria-hidden="true" />
                  </Button>
                </Card>
              );
            })}
          </div>
          <div className="order-metrics-provenance">
            <Badge tone={data.freshness === 'fresh' ? 'neutral' : 'warning'}>
              {data.freshness === 'fresh'
                ? 'Recent observations'
                : data.freshness === 'stale'
                  ? 'Stale observations'
                  : 'No observations'}
            </Badge>
            <span>
              Source observation age:{' '}
              {data.observedAt
                ? observationAge(data.readAt, data.observedAt)
                : 'unknown'}{' '}
              · Latest source observation{' '}
              {data.observedAt ? (
                <WorkspaceDate value={data.observedAt} />
              ) : (
                'unavailable'
              )}{' '}
              · Evaluated <WorkspaceDate value={data.asOf} /> · Complete totals
              unavailable.
            </span>
          </div>
        </>
      ) : null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="order-cohort-dialog" finalFocus={trigger}>
          <DialogHeader>
            <DialogTitle>
              {metric?.definition.title ?? 'Order records'}
            </DialogTitle>
            <DialogDescription>
              Inspect the counting rule and matching orders from one consistent
              snapshot. Live updates return this list to the first page.
            </DialogDescription>
          </DialogHeader>
          {metric && data ? (
            <>
              <div className="order-cohort-definition">
                <Badge tone="neutral">
                  Definition v{metric.definition.version}
                </Badge>
                <p>{metric.definition.description}</p>
                <p>{metric.definition.timeSemantics}</p>
              </div>
              <dl className="order-cohort-facts">
                <div>
                  <dt>Known matches</dt>
                  <dd>{metric.observedCount}</dd>
                </div>
                <div>
                  <dt>Unknown classification</dt>
                  <dd>{metric.unknownCount}</dd>
                </div>
                <div>
                  <dt>Source coverage</dt>
                  <dd>{data.coverage}</dd>
                </div>
              </dl>
              <p className="order-cohort-note">
                {data.coverageExplanation}{' '}
                {metric.unknownCount
                  ? 'Unknown orders are excluded from the known matches.'
                  : ''}
              </p>
              <div className="order-cohort-timestamps">
                <span>
                  Scope: all workspace connections · Current accepted state
                </span>
                <span>
                  Evaluated <WorkspaceDate value={data.asOf} />
                </span>
                <span>
                  Latest observation{' '}
                  {data.observedAt ? (
                    <WorkspaceDate value={data.observedAt} />
                  ) : (
                    'unavailable'
                  )}
                </span>
                <span>Complete data through: unavailable</span>
              </div>
              <Cohort metric={metric} organizationId={organizationId} />
              <Link
                className="order-cohort-open"
                to="/app/$organizationId/orders"
                params={{ organizationId }}
                search={{ view: cohortViews[metric.definition.id] }}
              >
                Open these orders in Orders{' '}
                <ArrowRight size={12} aria-hidden="true" />
              </Link>
              <div className="order-cohort-pagination">
                <span>
                  {metric.observedCount
                    ? `${Math.min(data.offset + 1, metric.observedCount)}–${Math.min(data.offset + metric.items.length, metric.observedCount)} of ${metric.observedCount} known matches`
                    : 'No known matching orders'}
                </span>
                <div>
                  <Button
                    variant="outline"
                    disabled={data.offset === 0 || query.isFetching}
                    onClick={() =>
                      setRequest({
                        asOf: data.asOf,
                        snapshot: data.snapshot,
                        offset: Math.max(0, data.offset - data.limit),
                      })
                    }
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    disabled={
                      data.offset + data.limit >= metric.observedCount ||
                      data.offset + data.limit > 10000 ||
                      query.isFetching
                    }
                    onClick={() =>
                      setRequest({
                        asOf: data.asOf,
                        snapshot: data.snapshot,
                        offset: data.offset + data.limit,
                      })
                    }
                  >
                    Next
                  </Button>
                </div>
              </div>
            </>
          ) : query.isPending ? (
            <CaseLoading />
          ) : (
            <CaseNotice
              error
              title={
                conflict ? 'The matching orders changed' : 'Records unavailable'
              }
            >
              Refresh to inspect current records.{' '}
              <Button variant="outline" onClick={refresh}>
                Refresh orders
              </Button>
            </CaseNotice>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

function Cohort({
  metric,
  organizationId,
}: {
  metric: Metric;
  organizationId: string;
}) {
  const location = useLocation();
  if (!metric.items.length)
    return (
      <div className="order-cohort-empty">
        <PackageOpen size={28} aria-hidden="true" />
        <strong>No observed matches</strong>
        <p>
          Incomplete source coverage means this does not establish a complete
          zero.
        </p>
      </div>
    );

  return (
    <ul className="order-cohort-list" aria-label="Matching orders">
      {metric.items.map((order) => (
        <li key={order.id}>
          <div>
            <strong>{order.displayNumber ?? 'Order without a number'}</strong>
            <code title={order.id}>{order.id}</code>
            <Link
              to="/app/$organizationId/orders/$orderId"
              params={{ organizationId, orderId: order.id }}
              search={{
                from: `${location.pathname}?metric=${encodeURIComponent(metric.definition.id)}`,
              }}
            >
              Open order <ArrowRight size={12} aria-hidden="true" />
            </Link>
          </div>
          <div>
            {order.dueAt ? (
              <span>
                Due <WorkspaceDate value={order.dueAt} />
              </span>
            ) : (
              <span>No source deadline</span>
            )}
            {order.issueIds.map((id) => (
              <Link
                key={id}
                to="/app/$organizationId/exceptions/$exceptionId"
                params={{ organizationId, exceptionId: id }}
                search={{ view: 'needs_you' }}
              >
                Review issue <ArrowRight size={12} aria-hidden="true" />
              </Link>
            ))}
          </div>
        </li>
      ))}
    </ul>
  );
}

// Each order metric has an Orders view that applies the same definition.
const cohortViews = {
  'orders.open': 'outstanding',
  'orders.overdue': 'overdue',
  'orders.attention': 'needs_you',
} as const;

function observationAge(readAt: string, observedAt: string) {
  const seconds = Math.max(
    0,
    Math.floor((Date.parse(readAt) - Date.parse(observedAt)) / 1000),
  );
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;

  return `${Math.floor(seconds / 3600)}h`;
}
