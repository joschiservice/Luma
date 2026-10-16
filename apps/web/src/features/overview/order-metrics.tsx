import './order-metrics.css';

import type { MetricRequest, MetricResponse } from '@luma/api-contract';
import { formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { rich } from '@luma/i18n/rich';
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
import { RefreshButton } from '@luma/ui/components/primitives/refresh-button';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { useSlowRequest } from '@luma/ui/lib/use-slow-request';
import { Link, useLocation } from '@tanstack/react-router';
import {
  ArrowRight,
  ArrowUpRight,
  Clock3,
  ListChecks,
  PackageOpen,
  ShoppingCart,
} from 'lucide-react';
import { type Ref, useImperativeHandle, useRef, useState } from 'react';

import {
  metricDescription,
  metricTimeSemantics,
  metricTitle,
} from './metric-text';
import { metricsOptions } from './metrics-data';
import {
  type LiveMetricView,
  type MetricInspector,
  usePagedMetric,
} from './metrics-live';

type Metric = MetricResponse['metrics'][number];

const icons = [PackageOpen, Clock3, ListChecks];

const coverageLabels = {
  partial: m.overview_orders_coverage_partial,
  unavailable: m.overview_orders_coverage_unavailable,
} satisfies Record<MetricResponse['coverage'], () => string>;

/** The order view a page requests in its metric summary. */
export const orderMetricRequest: MetricRequest = {};

// One line under each order count in the group card; metrics added later show their description.
const hints: Partial<Record<string, () => string>> = {
  'orders.open': m.overview_orders_hint_open,
  'orders.overdue': m.overview_orders_hint_overdue,
  'orders.attention': m.overview_orders_hint_attention,
};

/**
 * Presents source-aware order counts and lets operators inspect their exact matching records.
 * `live` is this widget's slice of the page's metric summary, read with `orderMetricRequest`.
 * The `group` variant is one card in a grid of metric groups; the page around it shows the
 * live status and refresh, and the card states only what is specific to orders. `inspector`
 * lets the page open the record dialog of an order metric.
 */
export function OrderMetrics({
  organizationId,
  live,
  variant = 'section',
  inspector,
}: {
  organizationId: string;
  live: LiveMetricView<MetricResponse>;
  variant?: 'section' | 'group';
  inspector?: Ref<MetricInspector>;
}) {
  return (
    <LiveOrderMetrics
      key={organizationId}
      organizationId={organizationId}
      live={live}
      variant={variant}
      inspector={inspector}
    />
  );
}

function LiveOrderMetrics({
  organizationId,
  live,
  variant,
  inspector,
}: {
  organizationId: string;
  live: LiveMetricView<MetricResponse>;
  variant: 'section' | 'group';
  inspector: Ref<MetricInspector> | undefined;
}) {
  const location = useLocation();
  const restoredMetric = new URLSearchParams(location.searchStr).get('metric');
  const trigger = useRef<HTMLButtonElement>(null);
  const { records, page, next, previous, first, connection } = usePagedMetric(
    live,
    orderMetricRequest,
    (paged: MetricRequest) => metricsOptions(organizationId, paged),
  );
  const [selected, setSelected] = useState(
    restoredMetric?.startsWith('orders.') ? restoredMetric : 'orders.open',
  );
  const [open, setOpen] = useState(
    Boolean(restoredMetric?.startsWith('orders.')),
  );
  const offline = connection === 'denied' || connection === 'offline';
  const data = live.isError || live.isPaused || offline ? undefined : live.data;
  // The dialog lists the page the person is reading; the cards keep showing live counts.
  const shown =
    records.isError || records.isPaused || offline ? undefined : records.data;
  const metric = shown?.metrics.find((m) => m.definition.id === selected);
  const latest = data?.metrics.find((m) => m.definition.id === selected);
  const changed =
    page > 1 &&
    !!metric &&
    !!latest &&
    latest.observedCount !== metric.observedCount;
  const slow = useSlowRequest(live.isFetching);
  const refresh = () => {
    first();
    void live.refetch();
  };

  const dialog = (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) first();
      }}
    >
      <DialogContent className="order-cohort-dialog" finalFocus={trigger}>
        <DialogHeader>
          <DialogTitle>
            {metric
              ? metricTitle(metric.definition)
              : m.overview_orders_dialog_title_fallback()}
          </DialogTitle>
          <DialogDescription>
            {m.overview_orders_dialog_description()}
          </DialogDescription>
        </DialogHeader>
        {metric && shown ? (
          <>
            <div className="order-cohort-definition">
              <Badge tone="neutral">
                {m.overview_orders_rule_version({
                  version: metric.definition.version,
                })}
              </Badge>
              <p>{metricDescription(metric.definition)}</p>
              <p>{metricTimeSemantics(metric.definition)}</p>
            </div>
            <dl className="order-cohort-facts">
              <div>
                <dt>{m.overview_orders_fact_matching()}</dt>
                <dd>{formatNumber(metric.observedCount)}</dd>
              </div>
              <div>
                <dt>{m.common_unknown()}</dt>
                <dd>{formatNumber(metric.unknownCount)}</dd>
              </div>
              <div>
                <dt>{m.overview_orders_fact_coverage()}</dt>
                <dd>{coverageLabels[shown.coverage]()}</dd>
              </div>
            </dl>
            <p className="order-cohort-note">
              {shown.coverageExplanation}{' '}
              {metric.unknownCount ? m.overview_orders_unknown_note() : ''}
            </p>
            <div className="order-cohort-timestamps">
              <span>{m.overview_orders_scope()}</span>
              <span>
                {rich(m.overview_orders_calculated, {
                  time: <WorkspaceDate value={shown.asOf} />,
                })}
              </span>
              <span>
                {shown.observedAt
                  ? rich(m.overview_orders_latest, {
                      time: <WorkspaceDate value={shown.observedAt} />,
                    })
                  : m.overview_orders_latest_none()}
              </span>
              <span>{m.overview_orders_completeness()}</span>
            </div>
            {changed ? (
              <CaseNotice title={m.overview_orders_changed_title()}>
                {m.overview_orders_changed_body()}{' '}
                <Button variant="outline" size="sm" onClick={first}>
                  {m.overview_records_show_latest()}
                </Button>
              </CaseNotice>
            ) : null}
            <Cohort metric={metric} organizationId={organizationId} />
            <Link
              className="order-cohort-open"
              to="/app/$organizationId/orders"
              params={{ organizationId }}
              search={{ view: cohortViews[metric.definition.id] }}
            >
              {m.overview_orders_open_in_orders()}{' '}
              <ArrowRight size={12} aria-hidden="true" />
            </Link>
            <div className="order-cohort-pagination">
              <span>
                {metric.observedCount
                  ? m.overview_orders_range({
                      from: Math.min(metric.offset + 1, metric.observedCount),
                      to: Math.min(
                        metric.offset + metric.items.length,
                        metric.observedCount,
                      ),
                      total: metric.observedCount,
                    })
                  : m.overview_orders_none()}
              </span>
              <div>
                <Button
                  variant="outline"
                  disabled={page === 1}
                  onClick={previous}
                >
                  {m.common_previous()}
                </Button>
                <Button
                  variant="outline"
                  disabled={!metric.nextCursor}
                  onClick={() => {
                    if (metric.nextCursor) next(metric.nextCursor);
                  }}
                >
                  {m.common_next()}
                </Button>
              </div>
            </div>
          </>
        ) : records.isPending ? (
          <CaseLoading />
        ) : (
          <CaseNotice error title={m.overview_orders_records_error_title()}>
            {m.overview_orders_records_error_body()}{' '}
            <Button variant="outline" onClick={refresh}>
              {m.overview_orders_refresh()}
            </Button>
          </CaseNotice>
        )}
      </DialogContent>
    </Dialog>
  );

  const inspect = (id: string, element: HTMLButtonElement) => {
    trigger.current = element;
    setSelected(id);
    first();
    setOpen(true);
  };
  useImperativeHandle(inspector, () => ({ inspect }));

  if (variant === 'group')
    return (
      <Card
        as="section"
        className="operational-group order-metrics-group"
        aria-labelledby="order-metrics-title"
      >
        <header>
          <ShoppingCart size={17} aria-hidden="true" />
          <div>
            <h3 id="order-metrics-title">{m.overview_orders_eyebrow()}</h3>
            <p>{m.overview_orders_group_subtitle()}</p>
          </div>
        </header>
        {connection === 'denied' ? (
          <p className="operational-group-state">
            {m.overview_orders_status_denied()}
          </p>
        ) : live.isPaused || connection === 'offline' ? (
          <p className="operational-group-state">
            <strong>{m.overview_orders_paused_title()}</strong>{' '}
            {m.overview_orders_paused_body()}
          </p>
        ) : live.isError ? (
          <p className="operational-group-state" role="alert">
            <strong>{m.overview_orders_error_title()}</strong>{' '}
            {m.overview_orders_error_body()}
          </p>
        ) : live.isPending || !data ? (
          <div className="operational-group-loading" aria-hidden="true">
            <span className="lu-skeleton" />
            <span className="lu-skeleton" />
            <span className="lu-skeleton" />
          </div>
        ) : (
          <>
            <div>
              {data.metrics.map((item) => (
                <button
                  type="button"
                  className="operational-row"
                  key={item.definition.id}
                  data-metric={item.definition.id}
                  onClick={(event) =>
                    inspect(item.definition.id, event.currentTarget)
                  }
                >
                  <span className="operational-label">
                    {metricTitle(item.definition)}
                    <small>
                      {data.coverage === 'unavailable'
                        ? m.overview_orders_value_none()
                        : (hints[item.definition.id]?.() ??
                          metricDescription(item.definition))}
                    </small>
                  </span>
                  <strong
                    className="operational-value"
                    data-tone={
                      item.definition.id === 'orders.attention' &&
                      data.coverage !== 'unavailable' &&
                      item.observedCount > 0
                        ? 'attention'
                        : undefined
                    }
                  >
                    {data.coverage === 'unavailable'
                      ? m.common_empty_value()
                      : formatNumber(item.observedCount)}
                  </strong>
                  <ArrowUpRight size={14} aria-hidden="true" />
                </button>
              ))}
            </div>
            {data.observedAt ? (
              <p className="operational-group-footer">
                {data.freshness === 'fresh' ? null : (
                  <Badge tone="warning">
                    {data.freshness === 'stale'
                      ? m.overview_orders_freshness_stale()
                      : m.overview_orders_freshness_none()}
                  </Badge>
                )}
                <span>
                  {rich(m.overview_orders_latest, {
                    time: <WorkspaceDate value={data.observedAt} />,
                  })}
                </span>
              </p>
            ) : null}
          </>
        )}
        {dialog}
      </Card>
    );

  return (
    <section className="order-metrics" aria-labelledby="order-metrics-title">
      <header className="order-metrics-heading">
        <div>
          <p className="order-metrics-eyebrow">{m.overview_orders_eyebrow()}</p>
          <h2 id="order-metrics-title">{m.overview_orders_title()}</h2>
          <p>{m.overview_orders_description()}</p>
        </div>
        <RefreshButton
          label={m.overview_orders_refresh()}
          refreshing={live.isFetching}
          onClick={refresh}
          disabled={
            live.isPaused || connection === 'offline' || connection === 'denied'
          }
        />
      </header>
      <div
        className="order-metrics-provenance"
        role="status"
        aria-live="polite"
      >
        <Badge
          tone={
            (connection === 'live' || connection === 'syncing') && !live.isError
              ? 'neutral'
              : 'warning'
          }
        >
          {connection === 'denied'
            ? m.overview_live_access_changed()
            : live.isPaused || connection === 'offline'
              ? m.overview_live_offline()
              : live.isError
                ? m.overview_live_unavailable()
                : connection === 'live'
                  ? slow
                    ? m.overview_live_updating()
                    : m.overview_live_on()
                  : connection === 'syncing'
                    ? m.overview_live_updating()
                    : connection === 'connecting'
                      ? m.overview_live_connecting()
                      : m.overview_live_reconnecting()}
        </Badge>
        <span>
          {connection === 'denied'
            ? m.overview_orders_status_denied()
            : connection === 'reconnecting'
              ? m.overview_orders_status_reconnecting()
              : m.overview_orders_status_default()}
        </span>
      </div>
      {connection === 'denied' ? null : live.isPaused ||
        connection === 'offline' ? (
        <CaseNotice title={m.overview_orders_paused_title()}>
          {m.overview_orders_paused_body()}
        </CaseNotice>
      ) : live.isError ? (
        <CaseNotice error title={m.overview_orders_error_title()}>
          {m.overview_orders_error_body()}
        </CaseNotice>
      ) : live.isPending ? (
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
                    <h3>{metricTitle(item.definition)}</h3>
                    <Badge tone="neutral">
                      {data.coverage === 'unavailable'
                        ? m.overview_orders_badge_unavailable()
                        : m.overview_orders_badge_partial()}
                    </Badge>
                  </div>
                  <div className="order-metric-value">
                    {data.coverage === 'unavailable'
                      ? m.common_empty_value()
                      : formatNumber(item.observedCount)}
                    <span>
                      {data.coverage === 'unavailable'
                        ? m.overview_orders_value_none()
                        : m.overview_orders_value_unit({
                            count: item.observedCount,
                          })}
                    </span>
                  </div>
                  <p>{metricDescription(item.definition)}</p>
                  <Button
                    variant="ghost"
                    onClick={(event) =>
                      inspect(item.definition.id, event.currentTarget)
                    }
                  >
                    {m.overview_orders_inspect()}{' '}
                    <ArrowRight size={14} aria-hidden="true" />
                  </Button>
                </Card>
              );
            })}
          </div>
          <div className="order-metrics-provenance">
            <Badge tone={data.freshness === 'fresh' ? 'neutral' : 'warning'}>
              {data.freshness === 'fresh'
                ? m.overview_orders_freshness_fresh()
                : data.freshness === 'stale'
                  ? m.overview_orders_freshness_stale()
                  : m.overview_orders_freshness_none()}
            </Badge>
            <span>
              {data.observedAt
                ? rich(m.overview_orders_provenance, {
                    time: <WorkspaceDate value={data.observedAt} />,
                    asOf: <WorkspaceDate value={data.asOf} />,
                  })
                : rich(m.overview_orders_provenance_none, {
                    asOf: <WorkspaceDate value={data.asOf} />,
                  })}
            </span>
          </div>
        </>
      ) : null}
      {dialog}
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
        <strong>{m.overview_orders_empty_title()}</strong>
        <p>{m.overview_orders_empty_body()}</p>
      </div>
    );

  return (
    <ul
      className="order-cohort-list"
      aria-label={m.overview_orders_list_label()}
    >
      {metric.items.map((order) => (
        <li key={order.id}>
          <div>
            <strong>
              {order.displayNumber ?? m.overview_orders_no_number()}
            </strong>
            <code title={order.id}>{order.id}</code>
            <Link
              to="/app/$organizationId/orders/$orderId"
              params={{ organizationId, orderId: order.id }}
              search={{
                from: `${location.pathname}?metric=${encodeURIComponent(metric.definition.id)}`,
              }}
            >
              {m.overview_orders_open_order()}{' '}
              <ArrowRight size={12} aria-hidden="true" />
            </Link>
          </div>
          <div>
            {order.dueAt ? (
              <span>
                {rich(m.overview_orders_due, {
                  time: <WorkspaceDate value={order.dueAt} />,
                })}
              </span>
            ) : (
              <span>{m.overview_orders_no_due()}</span>
            )}
            {order.issueIds.map((id) => (
              <Link
                key={id}
                to="/app/$organizationId/exceptions/$exceptionId"
                params={{ organizationId, exceptionId: id }}
                search={{ view: 'needs_you' }}
              >
                {m.overview_orders_review_issue()}{' '}
                <ArrowRight size={12} aria-hidden="true" />
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
