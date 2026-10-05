import type { Metrics } from '@luma/simulator-contract';

/** Metric series names the simulator host reports. */
export const metricNames = {
  ordersCreated: 'orders.created',
  ordersShipped: 'orders.shipped',
  ordersCancelled: 'orders.cancelled',
  returnsRequested: 'returns.requested',
  backlog: 'backlog',
  requests: 'requests',
  requestsFailed: 'requests.failed',
  latency: 'latency.mean',
  webhooksDelivered: 'webhooks.delivered',
  webhooksFailed: 'webhooks.failed',
  webhooksDropped: 'webhooks.dropped',
} as const;

/** Series matching a name and, when given, one instance. */
function select(metrics: Metrics, name: string, instance?: string) {
  return metrics.series.filter(
    (series) =>
      series.name === name &&
      (instance === undefined || series.instance === instance),
  );
}

/** Sums a counter over the window, across instances unless one is given. */
export function total(metrics: Metrics, name: string, instance?: string) {
  return select(metrics, name, instance).reduce(
    (sum, series) =>
      sum + series.points.reduce((acc, [, value]) => acc + value, 0),
    0,
  );
}

/**
 * Bucket start times covering the window. Points align either to the window start or to
 * multiples of the bucket length; both land in the same slots.
 */
export function bucketStarts(metrics: Metrics) {
  const size = Math.max(1, metrics.bucketMs);
  const first = Math.floor(metrics.from / size) * size;
  const starts: number[] = [];
  for (let start = first; start < metrics.to; start += size) starts.push(start);

  return starts;
}

/** Per-bucket values aligned with `bucketStarts`, summed across matching series. */
export function bucketValues(
  metrics: Metrics,
  name: string,
  instance?: string,
) {
  const size = Math.max(1, metrics.bucketMs);
  const starts = bucketStarts(metrics);
  const values = starts.map(() => 0);
  const first = starts[0] ?? 0;
  for (const series of select(metrics, name, instance))
    for (const [start, value] of series.points) {
      const index = Math.floor((start - first) / size);
      if (index >= 0 && index < values.length)
        values[index] = (values[index] ?? 0) + value;
    }

  return values;
}

/** The latest reported value of a gauge, summed across matching series; null when absent. */
export function latest(metrics: Metrics, name: string, instance?: string) {
  const matching = select(metrics, name, instance);
  let found = false;
  let sum = 0;
  for (const series of matching) {
    const last = series.points.reduce<[number, number] | undefined>(
      (newest, point) => (!newest || point[0] > newest[0] ? point : newest),
      undefined,
    );
    if (last) {
      found = true;
      sum += last[1];
    }
  }

  return found ? sum : null;
}

/** Instances that report a metric, in first-seen order. */
function instancesOf(metrics: Metrics, name: string) {
  return [
    ...new Set(
      select(metrics, name).flatMap((series) =>
        series.instance === null ? [] : [series.instance],
      ),
    ),
  ];
}

/** Request volume and failure share per instance over the window. */
export function requestHealth(metrics: Metrics) {
  return instancesOf(metrics, metricNames.requests).map((instance) => {
    const requests = total(metrics, metricNames.requests, instance);
    const failed = total(metrics, metricNames.requestsFailed, instance);

    return {
      instance,
      requests,
      failed,
      errorRate: requests > 0 ? failed / requests : null,
    };
  });
}

/**
 * Mean latency per instance over the window. Buckets are weighted by their request count when
 * the host reports one, so quiet buckets don't distort the mean.
 */
export function meanLatency(metrics: Metrics) {
  return instancesOf(metrics, metricNames.latency).map((instance) => {
    const latency = bucketValues(metrics, metricNames.latency, instance);
    const requests = bucketValues(metrics, metricNames.requests, instance);
    let weighted = 0;
    let weight = 0;
    latency.forEach((value, index) => {
      const count = requests[index] ?? 0;
      if (count > 0) {
        weighted += value * count;
        weight += count;
      }
    });
    if (weight === 0) {
      const reported = select(metrics, metricNames.latency, instance).flatMap(
        (series) => series.points.map(([, value]) => value),
      );
      weighted = reported.reduce((sum, value) => sum + value, 0);
      weight = reported.length;
    }

    return { instance, meanMs: weight > 0 ? weighted / weight : null };
  });
}

/** Webhook outcomes over the window and the share delivered; null when nothing was sent. */
export function webhookDelivery(metrics: Metrics) {
  const delivered = total(metrics, metricNames.webhooksDelivered);
  const failed = total(metrics, metricNames.webhooksFailed);
  const dropped = total(metrics, metricNames.webhooksDropped);
  const sent = delivered + failed + dropped;

  return {
    delivered,
    failed,
    dropped,
    deliveryRate: sent > 0 ? delivered / sent : null,
  };
}

/** Subtracts one aligned series from another, never going below zero. */
export const difference = (values: number[], minus: number[]) =>
  values.map((value, index) => Math.max(0, value - (minus[index] ?? 0)));
