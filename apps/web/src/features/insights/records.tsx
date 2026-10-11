import {
  caseClasses,
  type InsightChart,
  type InsightChartResponse,
  type InsightRecord,
  orderStageSchema,
} from '@luma/api-contract';
import {
  formatCalendarDate,
  formatList,
  formatNumber,
  formatRelativeTime,
} from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { rich } from '@luma/i18n/rich';
import {
  issueKind,
  issueStatus,
} from '@luma/ui/components/issues/case-presentation';
import { Alert, AlertDescription } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button, buttonVariants } from '@luma/ui/components/primitives/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@luma/ui/components/primitives/dialog';
import { StatePill } from '@luma/ui/components/primitives/state';
import { isPieceUnit } from '@luma/ui/lib/units';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowUpRight, RefreshCw } from 'lucide-react';

import {
  formatMoney,
  fulfillmentLabels,
  statusLabels,
} from '../../shared/orders/presentation';
import { signalLabels } from '../fulfillment/presentation';
import { orderStatuses } from '../orders/data';
import { stages } from '../procurement/presentation';
import type { Selection } from './chart-card';
import {
  insightRecordsOptions,
  type InsightScope,
  insightsError,
} from './data';
import {
  amount,
  chartCategories,
  coverageBadge,
  dataThroughText,
  definitions,
  moment,
  selectionTitle,
  selectionValue,
} from './presentation';

const unknownReasons: Record<string, () => string> = {
  missing: m.insights_unknown_reason_missing,
  deleted: m.insights_unknown_reason_deleted,
  nonnumeric: m.insights_unknown_reason_nonnumeric,
  future: m.insights_unknown_reason_future,
  expired: m.insights_unknown_reason_expired,
  invalid_time: m.insights_unknown_reason_invalid_time,
};

const isOrderStatus = (value: string | undefined) =>
  orderStatuses.find((status) => status === value);

const isCaseClass = (value: string | undefined) =>
  caseClasses.find((kind) => kind === value);

const stageOf = (value: string | undefined) =>
  orderStageSchema.options.find((stage) => stage === value);

const signalLabel = (signal: string) =>
  Object.entries(signalLabels).find(([key]) => key === signal)?.[1] ?? signal;

const attentionLabels: Record<string, () => string> = {
  approval: m.insights_attention_approval,
  manual_intervention: m.insights_attention_manual_intervention,
  uncertainty: m.insights_attention_uncertainty,
};

/** Shows a decimal quantity string with the active language's separators when it is numeric. */
const quantity = (value: string) => {
  const number = Number(value);

  return value.trim() && Number.isFinite(number) ? formatNumber(number) : value;
};

const ago = (value: string, now: number) => formatRelativeTime(value, now);

/** Formats an ISO calendar date such as `2026-10-08`; other values are shown as delivered. */
const calendarDate = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) ? formatCalendarDate(value) : value;

/**
 * Lists the exact records behind a chart point and series at the chart's evaluation time.
 * Each record opens its own page, with a way back to this list, and its decision in Needs you
 * when one is waiting. A different total than the chart showed means records changed since.
 */
export function RecordsSheet({
  organizationId,
  data,
  scope,
  selection,
  timeZone,
  returnPath,
  onSelect,
  onClose,
  onRefreshChart,
}: {
  organizationId: string;
  data: InsightChartResponse;
  scope: InsightScope;
  selection: Selection;
  timeZone: string;
  /** This Insights view, so a record page can link back to these records. */
  returnPath: string;
  onSelect: (selection: Selection) => void;
  onClose: () => void;
  onRefreshChart: () => void;
}) {
  const definition = definitions[data.chart];
  const query = useInfiniteQuery(
    insightRecordsOptions(
      organizationId,
      data.chart,
      scope,
      selection,
      data.asOf,
    ),
  );
  const pages = query.data?.pages ?? [];
  const items = pages.flatMap((page) => page.items);
  const total = pages[0]?.totalCount;
  const expected = selectionValue(data, selection);
  const error = insightsError(query.error);
  const point = data.points.find((p) => p.key === selection.point);
  const category = point
    ? chartCategories(data, timeZone).find((c) => c.key === point.key)
    : undefined;
  const badge = coverageBadge(data);
  const series = definition.series().filter((s) => data.series.includes(s.id));
  const scopeText = data.window
    ? point
      ? m.insights_records_scope_point({
          period: category?.label ?? point.key,
          timeZone: data.window.timeZone,
        })
      : data.window.bucket === 'day'
        ? m.insights_records_scope_days({ timeZone: data.window.timeZone })
        : m.insights_records_scope_weeks({ timeZone: data.window.timeZone })
    : m.insights_records_scope_now({ time: moment(data.asOf, timeZone) });
  const counted = amount(data.chart, total ?? 0);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent placement="sheet" className="insights-sheet">
        <DialogHeader>
          <p className="insights-sheet-eyebrow">{definition.title()}</p>
          <DialogTitle>{selectionTitle(data, selection, timeZone)}</DialogTitle>
          <DialogDescription>
            {scopeText} {definition.description()}
          </DialogDescription>
        </DialogHeader>
        <div className="insights-sheet-facts">
          <Badge tone={badge.tone}>{badge.label}</Badge>
          <span>{dataThroughText(data, timeZone)}</span>
          {category?.note && <span>{category.note}</span>}
        </div>
        {series.length > 1 && (
          <div
            className="insights-sheet-series"
            role="group"
            aria-label={m.insights_records_series_group()}
          >
            <Button
              variant="ghost"
              size="sm"
              aria-pressed={!selection.series}
              onClick={() => onSelect({ ...selection, series: undefined })}
            >
              {m.common_all()} ·{' '}
              {formatNumber(selectionValue(data, { point: selection.point }))}
            </Button>
            {series.map((s) => (
              <Button
                key={s.id}
                variant="ghost"
                size="sm"
                aria-pressed={selection.series === s.id}
                onClick={() => onSelect({ ...selection, series: s.id })}
              >
                <span className="lu-chart-key" data-color={s.color} />
                {s.label} ·{' '}
                {formatNumber(
                  selectionValue(data, {
                    point: selection.point,
                    series: s.id,
                  }),
                )}
              </Button>
            ))}
          </div>
        )}
        {error ? (
          <Alert tone="warning" role="alert">
            <AlertDescription>
              {error === 'outdated'
                ? m.insights_records_error_outdated()
                : error === 'access'
                  ? m.insights_records_error_access()
                  : m.insights_records_error_failed()}
              <Button variant="outline" size="sm" onClick={onRefreshChart}>
                <RefreshCw size={14} />
                {m.insights_records_refresh_chart()}
              </Button>
            </AlertDescription>
          </Alert>
        ) : query.isPending ? (
          <div
            className="insights-sheet-loading lu-skeleton"
            role="status"
            aria-label={m.insights_records_loading()}
          />
        ) : (
          <>
            <p className="insights-sheet-count" aria-live="polite">
              {total === expected
                ? rich(m.insights_records_count_matches, {
                    amount: <strong>{counted}</strong>,
                  })
                : rich(m.insights_records_count_differs, {
                    amount: <strong>{counted}</strong>,
                    expected: formatNumber(expected),
                  })}
            </p>
            {total !== expected && (
              <Alert tone="warning" role="status">
                <AlertDescription>
                  {m.insights_records_changed()}
                  <Button variant="outline" size="sm" onClick={onRefreshChart}>
                    <RefreshCw size={14} />
                    {m.insights_records_refresh_chart()}
                  </Button>
                </AlertDescription>
              </Alert>
            )}
            {items.length ? (
              <ul className="insights-records">
                {items.map((item) => (
                  <RecordRow
                    key={`${item.kind}:${item.id}:${'source' in item ? item.source.connectionId : ''}`}
                    item={item}
                    organizationId={organizationId}
                    timeZone={timeZone}
                    returnPath={returnPath}
                    asOf={data.asOf}
                  />
                ))}
              </ul>
            ) : (
              <p className="insights-sheet-empty">
                {m.insights_records_empty()}
              </p>
            )}
            {query.hasNextPage && (
              <Button
                variant="outline"
                size="sm"
                disabled={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                {query.isFetchingNextPage
                  ? m.common_loading()
                  : m.insights_records_show_more({
                      count: (total ?? 0) - items.length,
                    })}
              </Button>
            )}
          </>
        )}
        <WorkspaceLink
          chart={data.chart}
          organizationId={organizationId}
          selection={selection}
          data={data}
          returnPath={returnPath}
        />
      </DialogContent>
    </Dialog>
  );
}

/**
 * Opens the record workspace with the same filters. Orders filter exactly; the other
 * workspaces open their closest view, which the label says.
 */
function WorkspaceLink({
  chart,
  organizationId,
  selection,
  data,
  returnPath,
}: {
  chart: InsightChart;
  organizationId: string;
  selection: Selection;
  data: InsightChartResponse;
  returnPath: string;
}) {
  const point = data.points.find((p) => p.key === selection.point);
  const connectionId =
    data.sourceFilter === 'applied' && data.coverage.sources.length === 1
      ? data.coverage.sources[0]!.connectionId
      : undefined;
  const className = buttonVariants({ variant: 'outline', size: 'sm' });
  switch (chart) {
    case 'orders':
      return (
        <Link
          className={className}
          to="/app/$organizationId/orders"
          params={{ organizationId }}
          search={{
            ...(point?.start
              ? { placedFrom: point.start, placedTo: point.end ?? point.start }
              : data.window
                ? { placedFrom: data.window.start, placedTo: data.window.end }
                : {}),
            status: isOrderStatus(selection.series),
            ...(connectionId ? { connectionId } : {}),
            from: returnPath,
          }}
        >
          {m.insights_link_orders()}
          <ArrowUpRight size={14} />
        </Link>
      );
    case 'fulfillment':
      return (
        <Link
          className={className}
          to="/app/$organizationId/fulfillment"
          params={{ organizationId }}
          search={{
            view: selection.series === 'held' ? 'held' : 'open',
            sort: 'waiting',
            ...(connectionId ? { connectionId } : {}),
            from: returnPath,
          }}
        >
          {selection.series === 'held'
            ? m.insights_link_fulfillment_held()
            : m.insights_link_fulfillment_open()}
          <ArrowUpRight size={14} />
        </Link>
      );
    case 'stock':
      return (
        <Link
          className={className}
          to="/app/$organizationId/workflows/$definitionId"
          params={{ organizationId, definitionId: 'inventory-replenishment' }}
        >
          {m.insights_link_stock()}
          <ArrowUpRight size={14} />
        </Link>
      );
    case 'cases':
      return (
        <Link
          className={className}
          to="/app/$organizationId/exceptions"
          params={{ organizationId }}
          search={{
            view: 'active',
            class: isCaseClass(selection.series),
          }}
        >
          {isCaseClass(selection.series)
            ? m.insights_link_cases_kind()
            : m.insights_link_cases_all()}
          <ArrowUpRight size={14} />
        </Link>
      );
    default: {
      const stage = stageOf(selection.point);

      return (
        <Link
          className={className}
          to="/app/$organizationId/procurement"
          params={{ organizationId }}
          search={{
            view: 'orders',
            q: '',
            status: '',
            ...(stage ? { stage } : {}),
          }}
        >
          {stage
            ? m.insights_link_procurement_stage()
            : m.insights_link_procurement_all()}
          <ArrowUpRight size={14} />
        </Link>
      );
    }
  }
}

function RecordRow({
  item,
  organizationId,
  timeZone,
  returnPath,
  asOf,
}: {
  item: InsightRecord;
  organizationId: string;
  timeZone: string;
  returnPath: string;
  asOf: string;
}) {
  const now = Date.parse(asOf);
  switch (item.kind) {
    case 'order':
      return (
        <li className="insights-record">
          <Link
            className="insights-record-main"
            to="/app/$organizationId/orders/$orderId"
            params={{ organizationId, orderId: item.id }}
            search={{ from: returnPath }}
          >
            <strong>
              {item.number ??
                m.insights_record_order_fallback({ id: item.id.slice(0, 8) })}
            </strong>
            <span>
              {statusLabels[item.status] ?? item.status} ·{' '}
              {fulfillmentLabels[item.fulfillment] ?? item.fulfillment}
              {item.total ? ` · ${formatMoney(item.total)}` : ''}
            </span>
            <small>
              {item.placedAt
                ? m.insights_record_placed({
                    time: moment(item.placedAt, timeZone),
                  })
                : m.insights_record_no_placed_time()}{' '}
              · {formatList(item.sources.map((s) => s.label))}
            </small>
          </Link>
          {item.attentionIssueIds.map((issueId) => (
            <NeedsYou
              key={issueId}
              organizationId={organizationId}
              item={`case:${issueId}`}
            />
          ))}
        </li>
      );
    case 'fulfillment':
      return (
        <li className="insights-record">
          <Link
            className="insights-record-main"
            to="/app/$organizationId/fulfillment/$fulfillmentId"
            params={{ organizationId, fulfillmentId: item.id }}
            search={{ from: returnPath }}
          >
            <strong>
              {item.order.number ??
                m.insights_record_order_fallback({
                  id: item.order.id.slice(0, 8),
                })}
            </strong>
            <span>
              {item.signals.length
                ? item.signals.map(signalLabel).join(' · ')
                : m.insights_fulfillment_series_none()}
              {' · '}
              {item.unit && !isPieceUnit(item.unit)
                ? m.insights_record_units_unit_open({
                    units: quantity(item.units),
                    unit: item.unit,
                  })
                : m.insights_record_units_open({ units: quantity(item.units) })}
            </span>
            <small>
              {item.lastProgressAt
                ? m.insights_record_last_progress({
                    time: ago(item.progressAt, now),
                  })
                : m.insights_record_last_source_update({
                    time: ago(item.progressAt, now),
                  })}{' '}
              · {item.source.label}
              {item.locationName ? ` · ${item.locationName}` : ''}
            </small>
          </Link>
        </li>
      );
    case 'stock_position':
      return (
        <li className="insights-record">
          <Link
            className="insights-record-main"
            to="/app/$organizationId/inventory/$positionId"
            params={{ organizationId, positionId: item.id }}
            search={{ from: returnPath }}
          >
            <strong className="insights-mono">{item.sku}</strong>
            <span>
              {item.unknownReason
                ? (unknownReasons[item.unknownReason]?.() ??
                  m.insights_stock_point_unknown())
                : item.unit && !isPieceUnit(item.unit)
                  ? m.insights_record_stock_level_unit({
                      available:
                        item.available === null
                          ? m.common_unknown()
                          : formatNumber(item.available),
                      minimum: formatNumber(item.minimum),
                      unit: item.unit,
                    })
                  : m.insights_record_stock_level({
                      available:
                        item.available === null
                          ? m.common_unknown()
                          : formatNumber(item.available),
                      minimum: formatNumber(item.minimum),
                    })}
            </span>
            <small>
              {item.source.label}
              {item.observedAt
                ? ` · ${m.insights_record_read({ time: ago(item.observedAt, now) })}`
                : ''}
              {item.purchaseOrderIds.length
                ? ` · ${m.insights_record_purchase_orders({ count: item.purchaseOrderIds.length })}`
                : ''}
            </small>
          </Link>
          {item.purchaseOrderIds.slice(0, 2).map((id) => (
            <Link
              key={id}
              className="insights-record-action"
              to="/app/$organizationId/procurement/$purchaseOrderId"
              params={{ organizationId, purchaseOrderId: id }}
            >
              {m.insights_record_purchase_order_link()}
              <ArrowUpRight size={13} />
            </Link>
          ))}
          <Link
            className="insights-record-action"
            to="/app/$organizationId/workflows/$definitionId"
            params={{ organizationId, definitionId: 'inventory-replenishment' }}
            hash={`rule-${item.ruleId}`}
          >
            {m.insights_record_rule_link()}
            <ArrowUpRight size={13} />
          </Link>
        </li>
      );
    case 'case': {
      const status = issueStatus({
        state: item.state,
        attention: {
          required: item.attention !== null,
          reason: item.attention,
          explanation: '',
          requestedAt: null,
        },
        resolution: item.resolution,
        diagnosisStatus: 'ready',
      });

      return (
        <li className="insights-record">
          <Link
            className="insights-record-main"
            to="/app/$organizationId/exceptions/$exceptionId"
            params={{ organizationId, exceptionId: item.id }}
            search={{ view: item.state === 'resolved' ? 'history' : 'active' }}
          >
            <strong>{issueKind(item).label}</strong>
            <span>
              <StatePill state={status.state}>{status.label}</StatePill>
            </span>
            <small>
              {m.insights_record_detected({
                time: moment(item.detectedAt, timeZone),
              })}
              {item.resolvedAt
                ? ` · ${(item.resolution === 'verified'
                    ? m.insights_record_verified
                    : m.insights_record_closed)({
                    time: moment(item.resolvedAt, timeZone),
                  })}`
                : ''}
              {item.attention && attentionLabels[item.attention]
                ? ` · ${attentionLabels[item.attention]!()}`
                : ''}
            </small>
          </Link>
          {item.attention && (
            <NeedsYou
              organizationId={organizationId}
              item={`case:${item.id}`}
            />
          )}
        </li>
      );
    }
    case 'purchase_order': {
      const stage = stageOf(item.stage);

      return (
        <li className="insights-record">
          <Link
            className="insights-record-main"
            to="/app/$organizationId/procurement/$purchaseOrderId"
            params={{ organizationId, purchaseOrderId: item.id }}
          >
            <strong>{item.reference}</strong>
            <span>
              <StatePill state={stage ? stages[stage].state : 'idle'}>
                {stage ? stages[stage].label : item.stage}
              </StatePill>
              {item.overdue && (
                <Badge tone="warning">
                  {m.insights_procurement_series_overdue()}
                </Badge>
              )}
            </span>
            <small>
              {item.supplierName}
              {item.expectedDate
                ? ` · ${m.insights_record_expected({ date: calendarDate(item.expectedDate) })}`
                : ''}
              {item.attention
                ? ` · ${m.insights_record_items_to_answer({ count: item.attention })}`
                : ''}
            </small>
          </Link>
          {item.attention > 0 && (
            <Link
              className="insights-record-action"
              to="/app/$organizationId/needs-you"
              params={{ organizationId }}
              search={{ domain: 'procurement' }}
            >
              {m.insights_record_needs_you()}
              <ArrowUpRight size={13} />
            </Link>
          )}
        </li>
      );
    }
  }
}

function NeedsYou({
  organizationId,
  item,
}: {
  organizationId: string;
  item: string;
}) {
  return (
    <Link
      className="insights-record-action"
      data-tone="attention"
      to="/app/$organizationId/needs-you"
      params={{ organizationId }}
      search={{ item }}
    >
      {m.insights_record_decide()}
      <ArrowUpRight size={13} />
    </Link>
  );
}
