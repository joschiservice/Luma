import {
  caseClasses,
  type InsightChart,
  type InsightChartResponse,
  type InsightRecord,
  orderStageSchema,
} from '@luma/api-contract';
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
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowUpRight, RefreshCw } from 'lucide-react';

import { signalLabels } from '../fulfillment/presentation';
import { orderStatuses } from '../orders/data';
import {
  formatMoney,
  fulfillmentLabels,
  statusLabels,
} from '../orders/presentation';
import { stages } from '../procurement/presentation';
import { ago, count } from '../sync/presentation';
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

const unknownReasons: Record<string, string> = {
  missing: 'No stock read from the rule’s source',
  deleted: 'Removed at the source',
  nonnumeric: 'Source quantity isn’t a number',
  future: 'Read time is in the future',
  expired: 'Last read is more than 5 minutes old',
  invalid_time: 'Read time is invalid',
};

const isOrderStatus = (value: string | undefined) =>
  orderStatuses.find((status) => status === value);

const isCaseClass = (value: string | undefined) =>
  caseClasses.find((kind) => kind === value);

const stageOf = (value: string | undefined) =>
  orderStageSchema.options.find((stage) => stage === value);

const signalLabel = (signal: string) =>
  Object.entries(signalLabels).find(([key]) => key === signal)?.[1] ?? signal;

const attentionLabels: Record<string, string> = {
  approval: 'Waiting for an approval',
  manual_intervention: 'Needs a manual step',
  uncertainty: 'Needs review',
};

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
  const series = definition.series.filter((s) => data.series.includes(s.id));

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent placement="sheet" className="insights-sheet">
        <DialogHeader>
          <p className="insights-sheet-eyebrow">{definition.title}</p>
          <DialogTitle>{selectionTitle(data, selection, timeZone)}</DialogTitle>
          <DialogDescription>
            {data.window
              ? point
                ? `${category?.label ?? point.key} in ${data.window.timeZone}.`
                : `Every ${data.window.bucket} shown, in ${data.window.timeZone}.`
              : `As classified at ${moment(data.asOf, timeZone)}.`}{' '}
            {definition.description}
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
            aria-label="Show records for"
          >
            <Button
              variant="ghost"
              size="sm"
              aria-pressed={!selection.series}
              onClick={() => onSelect({ ...selection, series: undefined })}
            >
              All · {count(selectionValue(data, { point: selection.point }))}
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
                {count(
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
                ? 'This chart was read more than 15 minutes ago. Refresh it to list the records it counted.'
                : error === 'access'
                  ? 'Your access to this workspace changed.'
                  : 'Luma couldn’t list these records.'}
              <Button variant="outline" size="sm" onClick={onRefreshChart}>
                <RefreshCw size={14} />
                Refresh chart
              </Button>
            </AlertDescription>
          </Alert>
        ) : query.isPending ? (
          <div
            className="insights-sheet-loading lu-skeleton"
            role="status"
            aria-label="Loading records"
          />
        ) : (
          <>
            <p className="insights-sheet-count" aria-live="polite">
              <strong>{amount(data.chart, total ?? 0)}</strong>
              {total === expected
                ? ' · matches the chart'
                : ` · the chart showed ${count(expected)}`}
            </p>
            {total !== expected && (
              <Alert tone="warning" role="status">
                <AlertDescription>
                  Records changed after the chart was read. Refresh the chart to
                  count them again.
                  <Button variant="outline" size="sm" onClick={onRefreshChart}>
                    <RefreshCw size={14} />
                    Refresh chart
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
                No {definition.many} match this selection.
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
                  ? 'Loading…'
                  : `Show more (${count((total ?? 0) - items.length)} left)`}
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
          Open these orders in Orders
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
            ? 'All held work in Fulfillment'
            : 'All open work in Fulfillment'}
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
          Replenishment rules and readiness
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
          Active issues of this kind
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
          Open this stage in Procurement
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
            <strong>{item.number ?? `Order ${item.id.slice(0, 8)}`}</strong>
            <span>
              {statusLabels[item.status] ?? item.status} ·{' '}
              {fulfillmentLabels[item.fulfillment] ?? item.fulfillment}
              {item.total ? ` · ${formatMoney(item.total)}` : ''}
            </span>
            <small>
              {item.placedAt
                ? `Placed ${moment(item.placedAt, timeZone)}`
                : 'No placed time'}{' '}
              · {item.sources.map((s) => s.label).join(' + ')}
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
              {item.order.number ?? `Order ${item.order.id.slice(0, 8)}`}
            </strong>
            <span>
              {item.signals.length
                ? item.signals.map(signalLabel).join(' · ')
                : 'No signal'}
              {` · ${item.units}${item.unit && item.unit !== 'each' ? ` ${item.unit}` : ''} open`}
            </span>
            <small>
              Last progress {ago(item.progressAt, now)}
              {item.lastProgressAt
                ? ''
                : ' (from the last source update)'} · {item.source.label}
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
                ? (unknownReasons[item.unknownReason] ?? 'Stock unknown')
                : `${item.available} available · minimum ${item.minimum}${item.unit && item.unit !== 'each' ? ` ${item.unit}` : ''}`}
            </span>
            <small>
              {item.source.label}
              {item.observedAt ? ` · read ${ago(item.observedAt, now)}` : ''}
              {item.purchaseOrderIds.length
                ? ` · ${item.purchaseOrderIds.length} purchase order${item.purchaseOrderIds.length === 1 ? '' : 's'} recorded`
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
              Purchase order
              <ArrowUpRight size={13} />
            </Link>
          ))}
          <Link
            className="insights-record-action"
            to="/app/$organizationId/workflows/$definitionId"
            params={{ organizationId, definitionId: 'inventory-replenishment' }}
            hash={`rule-${item.ruleId}`}
          >
            Rule
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
              Detected {moment(item.detectedAt, timeZone)}
              {item.resolvedAt
                ? ` · ${item.resolution === 'verified' ? 'verified' : 'closed'} ${moment(item.resolvedAt, timeZone)}`
                : ''}
              {item.attention ? ` · ${attentionLabels[item.attention]}` : ''}
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
              {item.overdue && <Badge tone="warning">Overdue</Badge>}
            </span>
            <small>
              {item.supplierName}
              {item.expectedDate ? ` · expected ${item.expectedDate}` : ''}
              {item.attention
                ? ` · ${item.attention} item${item.attention === 1 ? '' : 's'} to answer`
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
              Needs you
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
      Decide in Needs you
      <ArrowUpRight size={13} />
    </Link>
  );
}
