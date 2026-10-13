import './operational-metrics.css';

import type {
  OperationalMetricRequest,
  OperationalMetricResponse,
} from '@luma/api-contract';
import { formatNumber, formatRelativeTime } from '@luma/i18n/format';
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
import { quantityUnit } from '@luma/ui/lib/units';
import { Link } from '@tanstack/react-router';
import {
  ArrowUpRight,
  Boxes,
  CircleAlert,
  ClipboardList,
  Plug,
} from 'lucide-react';
import { useRef, useState } from 'react';

import {
  metricDescription,
  metricTimeSemantics,
  metricTitle,
} from './metric-text';
import { type LiveMetricView, usePagedMetric } from './metrics-live';
import {
  operationalMetricRequest,
  operationalMetricsOptions,
} from './operational-metrics-data';
import { ResolutionEvidence } from './resolution-evidence';

type Metric = OperationalMetricResponse['metrics'][number];

type Item = Metric['items'][number];

/** A titled set of metrics on the summary. Without `metrics`, it shows one metric family. */
export interface MetricGroup {
  id: string;
  title: () => string;
  subtitle: () => string;
  icon: typeof CircleAlert;
  metrics?: string[];
}

const groups: MetricGroup[] = [
  {
    id: 'cases',
    title: m.overview_group_cases_title,
    subtitle: m.overview_group_cases_subtitle,
    icon: CircleAlert,
  },
  {
    id: 'inventory',
    title: m.overview_group_inventory_title,
    subtitle: m.overview_group_inventory_subtitle,
    icon: Boxes,
  },
  {
    id: 'procurement',
    title: m.overview_group_procurement_title,
    subtitle: m.overview_group_procurement_subtitle,
    icon: ClipboardList,
  },
  {
    id: 'connections',
    title: m.overview_group_connections_title,
    subtitle: m.overview_group_connections_subtitle,
    icon: Plug,
  },
];
const reasonLabels: Record<string, () => string> = {
  eligible: m.overview_eligibility_eligible,
  unknown_eligibility: m.overview_eligibility_unknown,
  unknown_attribution: m.overview_involvement_unknown,
  unknown_environment: m.overview_reason_unknown_environment,
  approval: m.overview_reason_approval,
  manual_intervention: m.overview_reason_manual_intervention,
  uncertainty: m.overview_reason_uncertainty,
  existing_commitment: m.overview_reason_existing_commitment,
  no_commitment: m.overview_reason_no_commitment,
  missing: m.overview_reason_missing,
  deleted: m.overview_reason_deleted,
  nonnumeric: m.overview_reason_nonnumeric,
  future: m.overview_reason_future,
  expired: m.overview_reason_expired,
  invalid_time: m.overview_reason_invalid_time,
  pending: m.overview_reason_pending,
  degraded: m.overview_reason_degraded,
  revoked: m.overview_reason_revoked,
  stale: m.overview_reason_stale,
  unobserved: m.overview_reason_unobserved,
};

// Reasons the server adds later fall back to their code until the client names them.
const reasonLabel = (reason: string) => reasonLabels[reason]?.() ?? reason;

const attentionHints: Record<string, (inputs: { count: number }) => string> = {
  approval: m.overview_hint_attention_approval,
  manual_intervention: m.overview_hint_attention_manual,
  uncertainty: m.overview_hint_attention_uncertainty,
};

const involvementLabels = {
  none: m.overview_involvement_none,
  human: m.overview_involvement_human,
  unknown: m.overview_involvement_unknown,
} satisfies Record<
  Extract<Item, { kind: 'resolution' }>['involvement'],
  () => string
>;

const eligibilityLabels = {
  eligible: m.overview_eligibility_eligible,
  ineligible: m.overview_eligibility_ineligible,
  unknown: m.overview_eligibility_unknown,
} satisfies Record<
  Extract<Item, { kind: 'resolution' }>['eligibility'],
  () => string
>;

const purchaseOrderStatusLabels = {
  draft: m.overview_po_status_draft,
  open: m.overview_po_status_open,
} satisfies Record<
  Extract<Item, { kind: 'purchase_order' }>['status'],
  () => string
>;

/**
 * Groups current operational priorities and opens their authorized matching records. `live` is
 * this widget's slice of the page's metric summary, read with `initialRequest`.
 */
export function OperationalMetrics({
  organizationId,
  live,
  initialRequest,
  heading = m.overview_pulse_title(),
  eyebrow,
  description = m.overview_pulse_description(),
  metricGroups = groups,
}: {
  organizationId: string;
  live: LiveMetricView<OperationalMetricResponse>;
  initialRequest?: OperationalMetricRequest;
  heading?: string;
  eyebrow?: string;
  description?: string;
  metricGroups?: MetricGroup[];
}) {
  const initial = initialRequest ?? operationalMetricRequest;
  const { records, page, next, previous, first, connection } = usePagedMetric(
    live,
    initial,
    (paged: OperationalMetricRequest) =>
      operationalMetricsOptions(organizationId, paged),
  );
  const [selected, setSelected] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const offline = connection === 'denied' || connection === 'offline';
  const unavailable = live.isError || live.isPaused || offline;
  const data = unavailable ? undefined : live.data;
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
  const refresh = () => {
    first();
    void live.refetch();
  };

  return (
    <section className="operational-metrics" aria-label={heading}>
      <header className="operational-heading">
        <div>
          <p className="order-metrics-eyebrow">
            {eyebrow ??
              (initialRequest
                ? m.overview_cohort_eyebrow()
                : m.overview_pulse_eyebrow())}
          </p>
          <h2>{heading}</h2>
          <p>{description}</p>
        </div>
        <div className="operational-status">
          <Badge tone={connection === 'live' ? 'neutral' : 'warning'}>
            {connection === 'denied'
              ? m.overview_live_access_changed()
              : connection === 'offline'
                ? m.overview_live_offline()
                : live.isError
                  ? m.overview_live_unavailable()
                  : connection === 'live'
                    ? m.overview_live_on()
                    : connection === 'syncing'
                      ? m.overview_live_updating()
                      : m.overview_live_connecting()}
          </Badge>
          <RefreshButton
            size="icon-sm"
            label={m.overview_refresh_summary()}
            refreshing={live.isFetching}
            onClick={refresh}
            disabled={
              live.isPaused ||
              connection === 'denied' ||
              connection === 'offline'
            }
          />
        </div>
      </header>
      {unavailable ? (
        <CaseNotice
          error
          title={
            connection === 'denied'
              ? m.overview_notice_access_title()
              : m.overview_notice_unavailable_title()
          }
        >
          {connection === 'denied'
            ? m.overview_notice_access_body()
            : connection === 'offline'
              ? m.overview_notice_offline_body()
              : m.overview_notice_unavailable_body()}
        </CaseNotice>
      ) : live.isPending ? (
        <CaseLoading />
      ) : data ? (
        <>
          <div className="operational-groups">
            {metricGroups.map((group) => {
              const Icon = group.icon;

              return (
                <Card as="div" className="operational-group" key={group.id}>
                  <header>
                    <Icon size={17} aria-hidden="true" />
                    <div>
                      <h3>{group.title()}</h3>
                      <p>{group.subtitle()}</p>
                    </div>
                  </header>
                  <div>
                    {data.metrics
                      .filter((m) =>
                        group.metrics
                          ? group.metrics.includes(m.definition.id)
                          : m.definition.family === group.id,
                      )
                      .map((m) => (
                        <button
                          type="button"
                          className="operational-row"
                          key={m.definition.id}
                          data-metric={m.definition.id}
                          onClick={(event) => {
                            trigger.current = event.currentTarget;
                            setSelected(m.definition.id);
                            first();
                          }}
                        >
                          <span className="operational-label">
                            {metricTitle(m.definition)}
                            <small>{metricHint(m)}</small>
                          </span>
                          <strong className="operational-value">
                            {metricValue(m)}
                          </strong>
                          <ArrowUpRight size={14} aria-hidden="true" />
                        </button>
                      ))}
                  </div>
                </Card>
              );
            })}
          </div>
          <p className="operational-footnote">
            {rich(m.overview_footnote, {
              time: <WorkspaceDate value={data.asOf} />,
            })}
          </p>
        </>
      ) : null}
      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSelected(null);
            first();
          }
        }}
      >
        <DialogContent className="operational-dialog" finalFocus={trigger}>
          <DialogHeader>
            <DialogTitle>
              {metric
                ? metricTitle(metric.definition)
                : m.overview_dialog_title_fallback()}
            </DialogTitle>
            <DialogDescription>
              {m.overview_dialog_description()}
            </DialogDescription>
          </DialogHeader>
          {metric && shown ? (
            <>
              <div className="order-cohort-definition">
                <Badge tone="neutral">
                  {metric.coverage === 'complete'
                    ? m.overview_coverage_complete()
                    : metric.coverage === 'partial'
                      ? m.overview_coverage_partial()
                      : m.overview_coverage_unavailable()}
                </Badge>
                <p>{metricDescription(metric.definition)}</p>
                <p>{metricTimeSemantics(metric.definition)}</p>
              </div>
              <dl className="order-cohort-facts">
                <div>
                  <dt>
                    {metric.definition.id === 'resolution.time_to_outcome'
                      ? m.overview_fact_median_duration()
                      : metric.definition.unit === 'second'
                        ? m.overview_fact_age()
                        : m.overview_fact_counted()}
                  </dt>
                  <dd>{metricValue(metric)}</dd>
                </div>
                <div>
                  <dt>{m.common_unknown()}</dt>
                  <dd>{formatNumber(metric.unknownCount)}</dd>
                </div>
                <div>
                  <dt>{m.overview_fact_population()}</dt>
                  <dd>{formatNumber(metric.population)}</dd>
                </div>
              </dl>
              {metric.breakdown.length ? (
                <div
                  className="operational-breakdown"
                  aria-label={m.overview_breakdown_label()}
                >
                  {metric.breakdown.map((b) => (
                    <Badge
                      key={b.reason}
                      tone={b.count ? 'warning' : 'neutral'}
                    >
                      {m.overview_breakdown_item({
                        reason: reasonLabel(b.reason),
                        count: b.count,
                      })}
                    </Badge>
                  ))}
                </div>
              ) : null}
              <p className="order-cohort-note">{metric.coverageExplanation}</p>
              {metric.definition.family === 'resolution' ? (
                <p className="order-cohort-note">
                  {metric.dataThrough
                    ? rich(m.overview_data_through, {
                        time: <WorkspaceDate value={metric.dataThrough} />,
                      })
                    : m.overview_data_through_unknown()}
                </p>
              ) : null}
              {changed ? (
                <CaseNotice title={m.overview_records_changed_title()}>
                  {m.overview_records_changed_body()}{' '}
                  <Button variant="outline" size="sm" onClick={first}>
                    {m.overview_records_show_latest()}
                  </Button>
                </CaseNotice>
              ) : null}
              {metric.items.length ? (
                <ul
                  className="operational-cohort"
                  aria-label={m.overview_records_label()}
                >
                  {metric.items.map((item) => (
                    <li key={item.id}>
                      <CohortItem item={item} organizationId={organizationId} />
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="order-cohort-empty">
                  <ClipboardList size={26} aria-hidden="true" />
                  <strong>
                    {metric.population === 0 &&
                    metric.definition.family === 'inventory'
                      ? m.overview_empty_no_rules_title()
                      : metric.definition.unit === 'second' &&
                          metric.unknownCount
                        ? m.overview_empty_no_detection_title()
                        : m.overview_empty_title()}
                  </strong>
                  <p>
                    {metric.unknownCount
                      ? m.overview_empty_unknown_body()
                      : metric.coverage === 'unavailable'
                        ? metric.definition.family === 'resolution'
                          ? m.overview_empty_resolution_body()
                          : m.overview_empty_inventory_body()
                        : m.overview_empty_body()}
                  </p>
                </div>
              )}
              <div className="order-cohort-pagination">
                <span>
                  {metric.observedCount
                    ? m.overview_records_range({
                        from: Math.min(metric.offset + 1, metric.observedCount),
                        to: Math.min(
                          metric.offset + metric.items.length,
                          metric.observedCount,
                        ),
                        total: metric.observedCount,
                      })
                    : m.overview_records_none()}{' '}
                  · <WorkspaceDate value={shown.asOf} />
                </span>
                <div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page === 1}
                    onClick={previous}
                  >
                    {m.common_previous()}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
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
            <CaseNotice error title={m.overview_records_error_title()}>
              {m.overview_records_error_body()}{' '}
              <Button variant="outline" onClick={refresh}>
                {m.overview_refresh_summary()}
              </Button>
            </CaseNotice>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

function metricValue(metric: Metric) {
  if (
    metric.definition.id === 'resolution.autonomous' &&
    metric.total === null &&
    metric.coverage !== 'unavailable'
  )
    return m.overview_value_known({ count: metric.observedCount });
  if (metric.definition.unit === 'second')
    return metric.value === null
      ? m.common_empty_value()
      : duration(metric.value);

  return metric.coverage === 'unavailable' || metric.value === null
    ? m.common_empty_value()
    : formatNumber(metric.value);
}

function metricHint(metric: Metric) {
  if (metric.definition.family === 'resolution')
    return metric.coverage === 'unavailable'
      ? m.overview_hint_resolution_empty()
      : metric.unknownCount
        ? m.overview_hint_resolution_unknown({ count: metric.unknownCount })
        : metric.definition.id === 'resolution.autonomous'
          ? m.overview_hint_resolution_autonomous()
          : m.overview_hint_resolution_default();
  if (metric.definition.unit === 'second')
    return metric.unknownCount
      ? m.overview_hint_duration_unknown()
      : m.overview_hint_duration_default();
  if (metric.definition.family === 'inventory') {
    if (!metric.population) return m.overview_hint_inventory_no_rules();
    if (metric.definition.id === 'inventory.below_minimum') {
      const count =
        metric.breakdown.find((b) => b.reason === 'no_commitment')?.count ?? 0;

      return metric.unknownCount
        ? m.overview_hint_inventory_not_ordered_unknown({
            count,
            unknown: metric.unknownCount,
          })
        : m.overview_hint_inventory_not_ordered({ count });
    }

    return m.overview_hint_inventory_default();
  }
  if (metric.definition.id === 'cases.attention')
    return (
      metric.breakdown
        .filter((b) => b.count && attentionHints[b.reason])
        .map((b) => attentionHints[b.reason]!({ count: b.count }))
        .join(' · ') || m.overview_hint_attention_none()
    );
  if (metric.definition.family === 'procurement')
    return metric.definition.id.endsWith('.draft')
      ? m.overview_hint_procurement_draft()
      : m.overview_hint_procurement_open();

  return metric.definition.family === 'connections'
    ? m.overview_hint_connections()
    : m.overview_hint_default();
}

const durationUnits = [
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60],
] as const;

// Shows a duration in its largest whole unit, such as “3h”, so values stay compact in the grid.
function duration(seconds: number) {
  const [unit, size] = durationUnits.find(([, size]) => seconds >= size) ?? [
    'second',
    1,
  ];

  return formatNumber(Math.floor(seconds / size), {
    style: 'unit',
    unit,
    unitDisplay: 'narrow',
  });
}

// Describes how long ago something happened from an age reported by the server.
const ago = (seconds: number) =>
  formatRelativeTime(Date.now() - seconds * 1000);

function CohortItem({
  item,
  organizationId,
}: {
  item: Item;
  organizationId: string;
}) {
  if (item.kind === 'resolution')
    return (
      <div className="resolution-cohort-item">
        <Link
          to="/app/$organizationId/exceptions/$exceptionId"
          params={{ organizationId, exceptionId: item.id }}
          search={{ view: item.outcome === 'verified' ? 'history' : 'active' }}
        >
          {item.title.replaceAll('_', ' ')}{' '}
          <ArrowUpRight size={13} aria-hidden="true" />
        </Link>
        <span>
          <Badge tone={item.involvement === 'unknown' ? 'warning' : 'neutral'}>
            {involvementLabels[item.involvement]()}
          </Badge>{' '}
          <Badge tone="neutral">{eligibilityLabels[item.eligibility]()}</Badge>
        </span>
        <small>
          {item.verifiedAt
            ? rich(m.overview_resolution_verified, {
                detected: <WorkspaceDate value={item.detectedAt} />,
                verified: <WorkspaceDate value={item.verifiedAt} />,
              })
            : rich(m.overview_resolution_pending, {
                detected: <WorkspaceDate value={item.detectedAt} />,
              })}
        </small>
        <ResolutionEvidence organizationId={organizationId} item={item} />
      </div>
    );
  if (item.kind === 'case')
    return (
      <>
        <div>
          <Link
            to="/app/$organizationId/exceptions/$exceptionId"
            params={{ organizationId, exceptionId: item.id }}
            search={{ view: 'active' }}
          >
            {item.title.replaceAll('_', ' ')}
            <ArrowUpRight size={13} aria-hidden="true" />
          </Link>
          <span>
            {item.subjectKind.replaceAll('_', ' ')} · {item.subjectId}
          </span>
          <small>
            {item.detectedAt && item.ageSeconds !== null
              ? rich(m.overview_case_detected, {
                  time: <WorkspaceDate value={item.detectedAt} />,
                  ago: ago(item.ageSeconds),
                })
              : m.overview_case_detected_unknown()}
          </small>
        </div>
        <Badge tone={item.reason ? 'warning' : 'neutral'}>
          {item.reason
            ? reasonLabel(item.reason)
            : item.state.replaceAll('_', ' ')}
        </Badge>
      </>
    );
  if (item.kind === 'purchase_order')
    return (
      <>
        <div>
          <Link
            to="/app/$organizationId/procurement/$purchaseOrderId"
            params={{ organizationId, purchaseOrderId: item.id }}
          >
            {item.reference}
            <ArrowUpRight size={13} aria-hidden="true" />
          </Link>
          <span>
            {item.supplierName} ·{' '}
            {item.authority === 'luma'
              ? m.overview_po_authority_luma()
              : m.overview_po_authority_external()}
          </span>
          <small>
            {item.ageSeconds !== null
              ? rich(m.overview_po_created_age, {
                  time: <WorkspaceDate value={item.createdAt} />,
                  ago: ago(item.ageSeconds),
                })
              : rich(m.overview_po_created, {
                  time: <WorkspaceDate value={item.createdAt} />,
                })}
          </small>
        </div>
        <Badge tone="neutral">{purchaseOrderStatusLabels[item.status]()}</Badge>
      </>
    );
  if (item.kind === 'connection')
    return (
      <>
        <div>
          <ConnectionLink id={item.id} organizationId={organizationId}>
            {item.label}
          </ConnectionLink>
          <small>
            {item.lastObservedAt
              ? rich(m.overview_connection_last_read, {
                  time: <WorkspaceDate value={item.lastObservedAt} />,
                })
              : m.overview_connection_never_read()}
          </small>
        </div>
        <div className="operational-breakdown">
          {item.reasons.map((reason) => (
            <Badge key={reason} tone="warning">
              {reasonLabel(reason)}
            </Badge>
          ))}
        </div>
      </>
    );

  return (
    <>
      <div>
        <strong>{item.sku}</strong>
        <span>
          {item.reason
            ? reasonLabel(item.reason)
            : item.available === null
              ? m.overview_stock_unknown()
              : item.unit
                ? m.overview_stock_available({
                    available: item.available,
                    unit: quantityUnit(item.unit, item.available),
                    minimum: item.minimum,
                  })
                : m.overview_stock_available_no_unit({
                    available: item.available,
                    minimum: item.minimum,
                  })}
        </span>
        <small>{m.overview_stock_position({ id: item.id.slice(0, 8) })}</small>
        <div className="operational-links">
          <Link
            to="/app/$organizationId/inventory/$positionId"
            params={{ organizationId, positionId: item.id }}
          >
            {m.overview_stock_open_position()}
            <ArrowUpRight size={12} aria-hidden="true" />
          </Link>
          <Link
            to="/app/$organizationId/workflows/$definitionId"
            params={{ organizationId, definitionId: 'inventory-replenishment' }}
            hash={`rule-${item.ruleId}`}
          >
            {m.overview_stock_open_rule()}
            <ArrowUpRight size={12} aria-hidden="true" />
          </Link>
          <ConnectionLink
            id={item.connectionId}
            organizationId={organizationId}
          >
            {m.overview_stock_open_connection()}
          </ConnectionLink>
        </div>
        {item.commitmentIds.map((id) => (
          <Link
            key={id}
            to="/app/$organizationId/procurement/$purchaseOrderId"
            params={{ organizationId, purchaseOrderId: id }}
          >
            {m.overview_stock_purchase_order({ id: id.slice(0, 8) })}
            <ArrowUpRight size={12} aria-hidden="true" />
          </Link>
        ))}
      </div>
      <Badge
        tone={item.reason || !item.commitmentIds.length ? 'warning' : 'neutral'}
      >
        {item.reason
          ? m.overview_stock_unknown()
          : item.commitmentIds.length
            ? m.overview_reason_existing_commitment()
            : m.overview_reason_no_commitment()}
      </Badge>
    </>
  );
}

function ConnectionLink({
  id,
  organizationId,
  children,
}: {
  id: string;
  organizationId: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      to="/app/$organizationId/apps"
      params={{ organizationId }}
      hash={`connection-${id}`}
    >
      {children}
      <ArrowUpRight size={12} aria-hidden="true" />
    </Link>
  );
}
