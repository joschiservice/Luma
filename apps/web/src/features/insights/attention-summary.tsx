import type {
  MetricResponse,
  OperationalMetricResponse,
} from '@luma/api-contract';
import { formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { StateDot } from '@luma/ui/components/primitives/state';
import type { RefObject } from 'react';

import { metricTitle } from '../overview/metric-text';
import type { LiveMetricView, MetricInspector } from '../overview/metrics-live';

// The counts on Now that mean someone has to act, in the order a person works through them.
// Connection health is in the toolbar, so it isn't repeated here.
const operationalAttention = [
  'cases.attention',
  'inventory.below_minimum',
  'inventory.replenishment_unknown',
];

type Entry = {
  id: string;
  title: string;
  /** Null when the count is unknown. */
  count: number | null;
  inspector: RefObject<MetricInspector | null>;
};

const usable = <Response,>(read: LiveMetricView<Response>) =>
  read.isError ||
  read.isPaused ||
  read.connection === 'denied' ||
  read.connection === 'offline'
    ? undefined
    : read.data;

/**
 * Lists the counts on Now that need someone, each opening its records, so the first line of the
 * page says where to start. Says that nothing needs attention only when every count is known;
 * an unknown count is named as unknown, never as zero.
 */
export function AttentionSummary({
  operational,
  orders,
  operationalInspector,
  ordersInspector,
}: {
  operational: LiveMetricView<OperationalMetricResponse>;
  orders: LiveMetricView<MetricResponse>;
  operationalInspector: RefObject<MetricInspector | null>;
  ordersInspector: RefObject<MetricInspector | null>;
}) {
  const operationalData = usable(operational);
  const ordersData = usable(orders);
  if (
    (operational.isPending && !operationalData) ||
    (orders.isPending && !ordersData)
  )
    return null;
  const entries: Entry[] = [
    ...operationalAttention.flatMap((id) => {
      const metric = operationalData?.metrics.find(
        (candidate) => candidate.definition.id === id,
      );
      if (operationalData && !metric) return [];

      return [
        {
          id,
          title: metric ? metricTitle(metric.definition) : id,
          count:
            metric && metric.coverage !== 'unavailable' ? metric.value : null,
          inspector: operationalInspector,
        },
      ];
    }),
    ...(ordersData?.coverage === 'unavailable'
      ? []
      : (ordersData?.metrics ?? [])
          .filter((metric) => metric.definition.id === 'orders.attention')
          .map((metric) => ({
            id: metric.definition.id,
            title: metricTitle(metric.definition),
            count: metric.observedCount,
            inspector: ordersInspector,
          }))),
  ];
  const waiting = entries.filter((entry) => (entry.count ?? 0) > 0);
  const unknown =
    !operationalData ||
    !ordersData ||
    entries.some((entry) => entry.count === null);

  return (
    <section
      className="insights-attention"
      aria-label={m.insights_attention_label()}
      data-state={waiting.length ? 'attention' : unknown ? 'unknown' : 'clear'}
    >
      {waiting.length ? (
        <>
          <h2 className="insights-attention-title">
            <StateDot state="attention" />
            {m.insights_attention_label()}
          </h2>
          <ul>
            {waiting.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  className="insights-attention-item"
                  onClick={(event) =>
                    entry.inspector.current?.inspect(
                      entry.id,
                      event.currentTarget,
                    )
                  }
                >
                  <strong>{formatNumber(entry.count ?? 0)}</strong>
                  {entry.title}
                </button>
              </li>
            ))}
          </ul>
          {unknown ? (
            <p className="insights-attention-note">
              {m.insights_attention_some_unknown()}
            </p>
          ) : null}
        </>
      ) : (
        <p className="insights-attention-title">
          <StateDot state={unknown ? 'idle' : 'verified'} />
          {unknown
            ? m.insights_attention_unknown()
            : m.insights_attention_clear()}
        </p>
      )}
    </section>
  );
}
