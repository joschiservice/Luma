import type { OrderDetail, OrderSourceFacts } from '@luma/api-contract';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import {
  DataTable,
  type DataTableColumn,
} from '@luma/ui/components/primitives/data-table';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { OrderSection } from './order-section';
import {
  formatMoney,
  formatQuantity,
  fulfillmentLabel,
  paymentLabels,
  statusLabels,
} from './presentation';

type OrderLine = OrderSourceFacts['lines'][number];

function lineColumns(
  organizationId: string,
  from: string,
): DataTableColumn<OrderLine>[] {
  return [
    {
      key: 'item',
      header: 'Item',
      cell: (line) => (
        <span className="orders-cell-stack">
          <span>{line.title ?? line.skuCode ?? 'Untitled item'}</span>
          <small>
            {line.skuCode ? `SKU ${line.skuCode}` : 'No SKU text'}
            {line.skuId ? (
              <>
                {' · '}
                <Link
                  to="/app/$organizationId/products/$skuId"
                  params={{ organizationId, skuId: line.skuId }}
                  search={{ from }}
                >
                  Product and stock
                </Link>
              </>
            ) : (
              ' · SKU not mapped'
            )}
          </small>
        </span>
      ),
    },
    {
      key: 'ordered',
      header: 'Ordered',
      numeric: true,
      cell: (line) => formatQuantity(line.quantity, line.unit),
    },
    {
      key: 'cancelled',
      header: 'Cancelled',
      numeric: true,
      cell: (line) =>
        line.cancelledQuantity === null
          ? 'Not reported'
          : formatQuantity(line.cancelledQuantity, line.unit),
    },
    {
      key: 'fulfilled',
      header: 'Fulfilled',
      numeric: true,
      cell: (line) => formatQuantity(line.fulfilledQuantity, line.unit),
    },
    {
      key: 'remaining',
      header: 'Remaining',
      numeric: true,
      cell: (line) =>
        line.remainingQuantity === null
          ? 'Unknown'
          : formatQuantity(line.remainingQuantity, line.unit),
    },
  ];
}

/**
 * Shows the order lines one source reports. With several sources, a switch chooses which
 * source's lines are shown; `from` is the order path that SKU record links return to.
 */
export function OrderLines({
  detail,
  shown,
  choose,
  organizationId,
  from,
}: {
  detail: OrderDetail;
  shown: OrderSourceFacts | undefined;
  choose: (connectionId: string) => void;
  organizationId: string;
  from: string;
}) {
  return (
    <OrderSection
      title="Lines"
      description="Fulfilled quantities count shipped, delivered or completed work reported by the same source."
    >
      {detail.sources.length > 1 ? (
        <div
          className="order-source-switch"
          role="group"
          aria-label="Source for lines"
        >
          {detail.sources.map((source) => (
            <Button
              key={source.connectionId}
              variant="ghost"
              size="sm"
              aria-pressed={shown?.connectionId === source.connectionId}
              onClick={() => choose(source.connectionId)}
            >
              {source.label}
            </Button>
          ))}
        </div>
      ) : null}
      {shown ? (
        <DataTable
          caption={`Lines reported by ${shown.label}`}
          columns={lineColumns(organizationId, from)}
          rows={shown.lines}
          rowKey={(line) => line.id}
          density="compact"
          empty={
            <p className="order-note">This source reports no order lines.</p>
          }
        />
      ) : null}
    </OrderSection>
  );
}

type ComparedFact = {
  label: string;
  field?: string;
  value: (source: OrderSourceFacts) => ReactNode;
};

const comparedFacts: ComparedFact[] = [
  { label: 'Number', value: (source) => source.displayNumber ?? '—' },
  {
    label: 'Status',
    field: 'status',
    value: (source) => statusLabels[source.status] ?? source.status,
  },
  {
    label: 'Payment',
    field: 'paymentStatus',
    value: (source) =>
      paymentLabels[source.paymentStatus] ?? source.paymentStatus,
  },
  {
    label: 'Total',
    field: 'total',
    value: (source) => formatMoney(source.total) ?? 'Not reported',
  },
  {
    label: 'Ordered items',
    field: 'lines',
    value: (source) =>
      source.lines
        .map(
          (line) =>
            `${formatQuantity(line.quantity, line.unit)} × ${line.skuCode ?? line.title ?? 'item'}`,
        )
        .join(', ') || 'None',
  },
  { label: 'Fulfillment', value: (source) => fulfillmentLabel(source) },
  {
    label: 'Placed',
    value: (source) =>
      source.placedAt ? <WorkspaceDate value={source.placedAt} /> : '—',
  },
  {
    label: 'Due',
    value: (source) =>
      source.dueAt ? <WorkspaceDate value={source.dueAt} /> : '—',
  },
  {
    label: 'Source updated',
    value: (source) =>
      source.sourceUpdatedAt ? (
        <WorkspaceDate value={source.sourceUpdatedAt} />
      ) : (
        'Not reported'
      ),
  },
];

/** Compares the facts each source reports side by side and marks the fields that differ. */
export function SourceComparison({ detail }: { detail: OrderDetail }) {
  const differs = new Set<string>(detail.differences.map((item) => item.field));
  const columns: DataTableColumn<ComparedFact>[] = [
    {
      key: 'field',
      header: 'Field',
      cell: (fact) => (
        <span className="order-comparison-field">
          {fact.label}
          {fact.field && differs.has(fact.field) ? (
            <Badge tone="warning">Differs</Badge>
          ) : null}
        </span>
      ),
    },
    ...detail.sources.map((source) => ({
      key: source.connectionId,
      header: `${source.label}${source.deleted ? ' (removed)' : ''}`,
      cell: (fact: ComparedFact) => fact.value(source),
    })),
  ];

  return (
    <OrderSection
      title="Source comparison"
      description="Each source keeps its own facts. Order numbers and dates are shown but not compared, because systems assign them independently."
    >
      <DataTable
        caption="Facts reported by each source"
        columns={columns}
        rows={comparedFacts}
        rowKey={(fact) => fact.label}
        density="compact"
      />
    </OrderSection>
  );
}
