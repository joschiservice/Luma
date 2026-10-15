import type {
  AuthorityGroup,
  OrderDetail,
  OrderSourceFacts,
} from '@luma/api-contract';
import { formatList } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Badge } from '@luma/ui/components/primitives/badge';
import {
  DataTable,
  type DataTableColumn,
} from '@luma/ui/components/primitives/data-table';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import type { ReactNode } from 'react';

import { formatQuantity } from '../../shared/orders/presentation';
import { authorityLabel } from './authority';

type Field = OrderDetail['differences'][number]['field'];

type Line = OrderSourceFacts['lines'][number];

type Row = {
  key: string;
  lineKey: string;
  item: string;
  field: Field;
  label: string;
  group: AuthorityGroup;
  lines: Map<string, Line>;
};

const fields: { field: Field; label: () => string; group: AuthorityGroup }[] = [
  { field: 'unit', label: m.orders_comparison_unit, group: 'order_lines' },
  {
    field: 'orderedQuantity',
    label: m.orders_lines_column_ordered,
    group: 'order_lines',
  },
  {
    field: 'currentQuantity',
    label: m.orders_lines_column_current,
    group: 'order_lines',
  },
  {
    field: 'cancelledQuantity',
    label: m.orders_lines_column_cancelled,
    group: 'order_lifecycle',
  },
  {
    field: 'fulfilledQuantity',
    label: m.orders_lines_column_fulfilled,
    group: 'order_fulfillment',
  },
  {
    field: 'remainingQuantity',
    label: m.orders_lines_column_remaining,
    group: 'order_fulfillment',
  },
  {
    field: 'fulfillment',
    label: m.orders_comparison_fulfillment,
    group: 'order_fulfillment',
  },
  {
    field: 'location',
    label: m.orders_comparison_location,
    group: 'order_fulfillment',
  },
  {
    field: 'overfulfillment',
    label: m.orders_comparison_overfulfillment,
    group: 'order_fulfillment',
  },
];

function value(
  row: Row,
  source: OrderSourceFacts,
  detail: OrderDetail,
  differences: Map<string, OrderDetail['differences'][number]>,
): ReactNode {
  const line = row.lines.get(source.connectionId);
  if (!line) return m.common_not_reported();
  const difference = differences.get(`${row.lineKey}:${row.field}`);
  const evidence = difference?.values.find(
    (item) => item.connectionId === source.connectionId,
  );
  const raw = evidence
    ? evidence.value
    : row.field === 'orderedQuantity'
      ? line.quantity
      : row.field === 'currentQuantity'
        ? line.currentQuantity
        : row.field === 'cancelledQuantity'
          ? line.cancelledQuantity
          : row.field === 'fulfilledQuantity'
            ? line.fulfilledQuantity
            : row.field === 'remainingQuantity'
              ? line.remainingQuantity
              : null;
  let shown: ReactNode;
  if (row.field === 'unit') shown = line.unit;
  else if (row.field === 'fulfillment') {
    const state =
      raw ??
      (line.currentQuantity === '0' && line.fulfilledQuantity === '0'
        ? 'not_required'
        : line.remainingQuantity === null
          ? null
          : line.remainingQuantity === '0'
            ? 'fulfilled'
            : line.fulfilledQuantity === '0'
              ? 'unfulfilled'
              : 'partial');
    shown =
      state === 'fulfilled'
        ? m.orders_fulfillment_fulfilled()
        : state === 'partial'
          ? m.orders_fulfillment_partial()
          : state === 'unfulfilled'
            ? m.orders_fulfillment_unfulfilled()
            : state === 'not_required'
              ? m.orders_fulfillment_not_required()
              : m.common_unknown();
  } else if (row.field === 'location') {
    const fulfillments = detail.fulfillments.filter(
      (item) =>
        !item.deleted &&
        item.connectionId === source.connectionId &&
        item.status !== 'cancelled' &&
        (item.kind === 'fulfillment_order' ||
          ['shipped', 'delivered', 'completed'].includes(item.status)) &&
        item.lines.some((l) => l.orderLineId === line.id),
    );
    if (evidence && raw !== null) {
      const allocations: unknown = JSON.parse(raw);
      shown = Array.isArray(allocations)
        ? formatList(
            allocations.flatMap((allocation: unknown) => {
              if (
                !Array.isArray(allocation) ||
                typeof allocation[0] !== 'string' ||
                typeof allocation[1] !== 'string'
              )
                return [];
              const [id, quantity] = allocation;
              const name = fulfillments.find(
                (item) => item.location?.locationId === id,
              )?.location?.name;

              return [`${name ?? id}: ${formatQuantity(quantity, line.unit)}`];
            }),
          )
        : m.common_not_reported();
    } else {
      const locations = fulfillments.flatMap((item) =>
        item.lines.some(
          (l) =>
            l.orderLineId === line.id &&
            (item.kind === 'fulfillment_order'
              ? l.remainingQuantity != null && Number(l.remainingQuantity) > 0
              : Number(l.quantity) > 0),
        )
          ? (item.location?.name ?? item.location?.locationId ?? [])
          : [],
      );
      shown =
        !evidence && locations.length
          ? formatList([...new Set(locations)])
          : m.common_not_reported();
    }
  } else if (row.field === 'overfulfillment')
    shown =
      raw === null
        ? line.currentQuantity === null && line.cancelledQuantity === null
          ? m.common_unknown()
          : m.common_none()
        : formatQuantity(raw, line.unit);
  else
    shown =
      raw === null ? m.common_not_reported() : formatQuantity(raw, line.unit);

  return (
    <span className="orders-cell-stack">
      <span>{shown}</span>
      {evidence
        ? evidence.evidence
            .filter(
              (read, index, reads) =>
                reads.findIndex(
                  (item) => item.observedAt === read.observedAt,
                ) === index,
            )
            .map((read) => (
              <small key={read.snapshotId}>
                <WorkspaceDate value={read.observedAt} />
              </small>
            ))
        : null}
    </span>
  );
}

/**
 * Shows each mapped line's quantities, shipment state and location with source authority and
 * read evidence. `only` limits it to one line, by comparison key or line ID, without the line
 * column.
 */
export function LineComparison({
  detail,
  only,
}: {
  detail: OrderDetail;
  only?: string | undefined;
}) {
  const differences = new Map(
    detail.differences.map((item) => [`${item.lineKey}:${item.field}`, item]),
  );
  const lines = new Map<string, { item: string; sources: Map<string, Line> }>();
  for (const source of detail.sources.filter((source) => !source.deleted))
    for (const line of source.lines) {
      const key = line.comparisonKey ?? line.id;
      const entry = lines.get(key) ?? {
        item: line.title ?? line.skuCode ?? m.orders_lines_untitled(),
        sources: new Map<string, Line>(),
      };
      entry.sources.set(source.connectionId, line);
      lines.set(key, entry);
    }
  const rows: Row[] = [...lines]
    .filter(([lineKey]) => only === undefined || lineKey === only)
    .flatMap(([lineKey, entry]) =>
      fields.map((field) => ({
        key: `${lineKey}:${field.field}`,
        lineKey,
        item: entry.item,
        field: field.field,
        label: field.label(),
        group: field.group,
        lines: entry.sources,
      })),
    );
  const labels = {
    matching: m.orders_comparison_matching,
    pending: m.orders_comparison_pending,
    confirmed: m.orders_comparison_confirmed,
    inconclusive: m.orders_comparison_inconclusive,
  };
  const lineColumn: DataTableColumn<Row>[] = [
    {
      key: 'line',
      header: m.orders_comparison_line(),
      cell: (row) => (
        <span className="orders-cell-stack">
          <span>{row.item}</span>
          {[...row.lines.values()].some((line) => !line.comparisonKey) ? (
            <small>{m.orders_comparison_unmapped()}</small>
          ) : null}
        </span>
      ),
    },
  ];
  const columns: DataTableColumn<Row>[] = [
    ...(only === undefined ? lineColumn : []),
    {
      key: 'field',
      header: m.orders_comparison_field(),
      cell: (row) => (
        <span className="order-comparison-field">
          {row.label}
          {differences.has(`${row.lineKey}:${row.field}`) ? (
            <Badge
              tone={
                detail.order.comparisonState === 'confirmed'
                  ? 'warning'
                  : 'neutral'
              }
            >
              {labels[detail.order.comparisonState]()}
            </Badge>
          ) : null}
        </span>
      ),
    },
    {
      key: 'authority',
      header: m.orders_authority_title(),
      cell: (row) =>
        authorityLabel(
          detail.authority.groups.find((group) => group.group === row.group),
          detail.sources.map((source) => ({
            id: source.connectionId,
            label: source.label,
          })),
        ),
    },
    ...detail.sources.map((source) => ({
      key: source.connectionId,
      header: source.label,
      cell: (row: Row) => value(row, source, detail, differences),
    })),
  ];

  return (
    <DataTable
      caption={m.orders_comparison_lines_caption()}
      columns={columns}
      rows={rows}
      rowKey={(row) => row.key}
      density="compact"
    />
  );
}
