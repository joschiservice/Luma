import type { Metrics, RunDetail } from '@luma/simulator-contract';
import { Badge } from '@luma/ui/components/primitives/badge';
import type {
  ChartCategory,
  ChartSeries,
} from '@luma/ui/components/primitives/bar-chart';
import { Select } from '@luma/ui/components/primitives/select';
import { useState } from 'react';

import { ChartCard } from '../../components/chart-card';
import { MetricTile } from '../../components/metric-tile';
import { LoadError, Loading } from '../../components/query-state';
import {
  formatBucket,
  formatCount,
  formatLatency,
  formatPercent,
  formatTime,
} from '../../lib/format';
import {
  bucketStarts,
  bucketValues,
  difference,
  latest,
  meanLatency,
  metricNames,
  requestHealth,
  total,
  webhookDelivery,
} from '../../lib/metrics';
import { useMetrics } from '../../queries';
import { InstancesCard } from './instances';

const windows = [
  { value: 'today', label: 'Today' },
  { value: '1h', label: 'Last hour' },
  { value: '6h', label: 'Last 6 hours' },
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
] as const;

type WindowName = (typeof windows)[number]['value'];

const fixed: Record<Exclude<WindowName, 'today'>, number> = {
  '1h': 3_600_000,
  '6h': 6 * 3_600_000,
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
};

/**
 * The window length in simulation milliseconds. "Today" runs from local midnight in
 * simulation time, rounded down to the minute so the query changes at most once a minute and
 * never reaches into yesterday's buckets.
 */
export function windowLength(name: WindowName, simNow: number) {
  if (name !== 'today') return fixed[name];
  const midnight = new Date(simNow);
  midnight.setHours(0, 0, 0, 0);

  return Math.max(
    60_000,
    Math.floor((simNow - midnight.getTime()) / 60_000) * 60_000,
  );
}

const longLabel = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

/** Builds chart categories from aligned bucket values, noting an incomplete last bucket. */
function bucketCategories(
  metrics: Metrics,
  values: Record<string, number[]>,
): ChartCategory[] {
  const span = metrics.to - metrics.from;

  return bucketStarts(metrics).map((start, index) => ({
    key: String(start),
    label: longLabel.format(start),
    axisLabel: formatBucket(start, span),
    values: Object.fromEntries(
      Object.entries(values).map(([id, list]) => [id, list[index] ?? 0]),
    ),
    ...(start + metrics.bucketMs > metrics.to
      ? { note: `Incomplete: data through ${formatTime(metrics.to)}` }
      : {}),
  }));
}

/** Operational pulse of the run: headline numbers, trends and provider instances. */
export function OverviewView({ run }: { run: RunDetail }) {
  const [windowName, setWindowName] = useState<WindowName>('today');
  const windowMs = windowLength(windowName, run.clock.now);
  const metrics = useMetrics(run.id, windowMs);
  const label = windows.find((w) => w.value === windowName)?.label ?? '';

  return (
    <div className="sim-stack">
      <div className="sim-toolbar">
        <h2 className="sim-section-title">Overview</h2>
        <Select
          aria-label="Time window"
          className="sim-window-select"
          value={windowName}
          options={windows}
          onValueChange={(value) => {
            if (value) setWindowName(value);
          }}
        />
      </div>
      {metrics.isPending ? (
        <Loading label="Loading metrics" />
      ) : metrics.isError && !metrics.data ? (
        <LoadError
          title="Metrics unavailable"
          error={metrics.error}
          onRetry={() => void metrics.refetch()}
        />
      ) : (
        <MetricsPanel
          run={run}
          metrics={metrics.data}
          windowLabel={label.toLowerCase()}
          busy={metrics.isPlaceholderData}
          stale={metrics.isError}
        />
      )}
      <InstancesCard
        run={run}
        health={metrics.data ? requestHealth(metrics.data) : []}
        latency={metrics.data ? meanLatency(metrics.data) : []}
      />
    </div>
  );
}

function MetricsPanel({
  run,
  metrics,
  windowLabel,
  busy,
  stale,
}: {
  run: RunDetail;
  metrics: Metrics;
  windowLabel: string;
  busy: boolean;
  stale: boolean;
}) {
  const [requestInstance, setRequestInstance] = useState('all');
  const requests = requestHealth(metrics);
  const allRequests = requests.reduce((sum, r) => sum + r.requests, 0);
  const allFailed = requests.reduce((sum, r) => sum + r.failed, 0);
  const webhooks = webhookDelivery(metrics);
  const backlog = latest(metrics, metricNames.backlog);
  const instance = requestInstance === 'all' ? undefined : requestInstance;
  const requestTotals = bucketValues(metrics, metricNames.requests, instance);
  const requestFailures = bucketValues(
    metrics,
    metricNames.requestsFailed,
    instance,
  );
  const instanceLabel = (name: string) =>
    run.instances.find((i) => i.name === name)?.label ?? name;
  const latency = meanLatency(metrics);
  const single = (id: string, label: string, color: ChartSeries['color']) => [
    { id, label, color },
  ];

  return (
    <>
      {stale ? (
        <p className="sim-error-text" role="status">
          Metrics could not refresh; values are from {formatTime(metrics.to)}{' '}
          simulation time.
        </p>
      ) : null}
      <div className="sim-tiles">
        <MetricTile
          label={`Orders created, ${windowLabel}`}
          value={formatCount(total(metrics, metricNames.ordersCreated))}
          detail={`${formatCount(run.counts.orders)} orders in this run`}
        />
        <MetricTile
          label="Open backlog"
          value={backlog === null ? null : formatCount(backlog)}
          detail="Open orders waiting for the warehouse"
        />
        <MetricTile
          label={`Shipped, ${windowLabel}`}
          value={formatCount(total(metrics, metricNames.ordersShipped))}
        />
        <MetricTile
          label={`Cancellations, ${windowLabel}`}
          value={formatCount(total(metrics, metricNames.ordersCancelled))}
        />
        <MetricTile
          label={`Returns requested, ${windowLabel}`}
          value={formatCount(total(metrics, metricNames.returnsRequested))}
        />
        <MetricTile
          label="Request error rate"
          value={
            allRequests > 0 ? formatPercent(allFailed / allRequests, 2) : null
          }
          detail={
            requests.length
              ? requests
                  .map(
                    (r) =>
                      `${instanceLabel(r.instance)} ${r.errorRate === null ? '—' : formatPercent(r.errorRate, 2)}`,
                  )
                  .join(' · ')
              : 'No provider requests in this window'
          }
        />
        <MetricTile
          label="Webhook delivery"
          value={
            webhooks.deliveryRate === null
              ? null
              : formatPercent(webhooks.deliveryRate, 2)
          }
          status={
            webhooks.failed + webhooks.dropped > 0 ? (
              <Badge tone="warning">
                {formatCount(webhooks.failed + webhooks.dropped)} not delivered
              </Badge>
            ) : null
          }
          detail={`${formatCount(webhooks.delivered)} delivered · ${formatCount(webhooks.failed)} failed · ${formatCount(webhooks.dropped)} dropped`}
        />
      </div>
      <div className="sim-chart-grid">
        <ChartCard
          title="Orders created"
          description="New shop orders per period."
          series={single('created', 'Orders created', 'chart-1')}
          categories={bucketCategories(metrics, {
            created: bucketValues(metrics, metricNames.ordersCreated),
          })}
          busy={busy}
        />
        <ChartCard
          title="Orders shipped"
          description="Orders the warehouse shipped per period."
          series={single('shipped', 'Orders shipped', 'chart-2')}
          categories={bucketCategories(metrics, {
            shipped: bucketValues(metrics, metricNames.ordersShipped),
          })}
          busy={busy}
        />
        <ChartCard
          title="Open backlog"
          description="Open orders waiting for the warehouse at each period."
          series={single('backlog', 'Open backlog', 'chart-3')}
          categories={bucketCategories(metrics, {
            backlog: bucketValues(metrics, metricNames.backlog),
          })}
          busy={busy}
        />
        <ChartCard
          title="Provider requests"
          description="Requests Luma and the integration sent, split by outcome."
          series={[
            { id: 'succeeded', label: 'Succeeded', color: 'chart-1' },
            { id: 'failed', label: 'Failed', color: 'error' },
          ]}
          categories={bucketCategories(metrics, {
            succeeded: difference(requestTotals, requestFailures),
            failed: requestFailures,
          })}
          busy={busy}
          controls={
            <Select
              aria-label="Provider instance"
              className="sim-instance-select"
              value={requestInstance}
              options={[
                { value: 'all', label: 'All instances' },
                ...run.instances.map((i) => ({
                  value: i.name,
                  label: i.label,
                })),
              ]}
              onValueChange={(value) => {
                if (value) setRequestInstance(value);
              }}
            />
          }
        />
        <ChartCard
          title="Webhooks"
          description="Webhook deliveries per period, by outcome."
          series={[
            { id: 'delivered', label: 'Delivered', color: 'chart-2' },
            { id: 'failed', label: 'Failed', color: 'error' },
            { id: 'dropped', label: 'Dropped', color: 'warning' },
          ]}
          categories={bucketCategories(metrics, {
            delivered: bucketValues(metrics, metricNames.webhooksDelivered),
            failed: bucketValues(metrics, metricNames.webhooksFailed),
            dropped: bucketValues(metrics, metricNames.webhooksDropped),
          })}
          busy={busy}
        />
        <ChartCard
          title="Mean latency"
          description="Average response time per instance over the window."
          orientation="horizontal"
          categoryHeader="Instance"
          series={single('latency', 'Mean latency', 'chart-4')}
          unit={formatLatency}
          categories={latency.map((entry) => ({
            key: entry.instance,
            label: instanceLabel(entry.instance),
            values: { latency: Math.round(entry.meanMs ?? 0) },
            ...(entry.meanMs === null ? { unknown: 'No requests' } : {}),
          }))}
          busy={busy}
        />
      </div>
    </>
  );
}
