import type {
  AuthorityGroup,
  OrderDetail,
  OrderSourceFacts,
} from '@luma/api-contract';
import { formatList } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import {
  DataTable,
  type DataTableColumn,
} from '@luma/ui/components/primitives/data-table';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { Link } from '@tanstack/react-router';
import { GitCompareArrows, ListOrdered } from 'lucide-react';
import type { ReactNode } from 'react';

import { OrderSection } from '../../shared/orders/order-section';
import {
  formatMoney,
  formatQuantity,
  formatSourceNumber,
  fulfillmentLabel,
  paymentLabels,
  statusLabels,
} from '../../shared/orders/presentation';
import { authorityLabel } from './authority';
import { LineComparison } from './line-comparison';

type OrderLine = OrderSourceFacts['lines'][number];

function lineColumns(
  organizationId: string,
  from: string,
): DataTableColumn<OrderLine>[] {
  return [
    {
      key: 'item',
      header: m.orders_lines_column_item(),
      cell: (line) => (
        <span className="orders-cell-stack">
          <span>{line.title ?? line.skuCode ?? m.orders_lines_untitled()}</span>
          {line.bundleGroup ? (
            <small>
              {m.products_bundles_group({
                title: line.bundleGroup.title,
                quantity: formatSourceNumber(line.bundleGroup.quantity),
              })}
            </small>
          ) : null}
          <small>
            {line.skuCode
              ? m.orders_lines_sku({ sku: line.skuCode })
              : m.orders_lines_no_sku()}
            {' · '}
            {line.catalog === 'variant_removed' ? (
              m.orders_lines_variant_removed()
            ) : line.catalog === 'no_product' ? (
              m.orders_lines_no_product()
            ) : line.skuId ? (
              <Link
                to="/app/$organizationId/products/$skuId"
                params={{ organizationId, skuId: line.skuId }}
                search={{ from }}
              >
                {m.orders_lines_product_link()}
              </Link>
            ) : (
              m.orders_lines_sku_unlinked()
            )}
          </small>
        </span>
      ),
    },
    {
      key: 'current',
      header: m.orders_lines_column_current(),
      numeric: true,
      cell: (line) =>
        line.currentQuantity === null
          ? m.common_not_reported()
          : formatQuantity(line.currentQuantity, line.unit),
    },
    {
      key: 'ordered',
      header: m.orders_lines_column_ordered(),
      numeric: true,
      cell: (line) => formatQuantity(line.quantity, line.unit),
    },
    {
      key: 'cancelled',
      header: m.orders_lines_column_cancelled(),
      numeric: true,
      cell: (line) =>
        line.cancelledQuantity === null
          ? m.common_not_reported()
          : formatQuantity(line.cancelledQuantity, line.unit),
    },
    {
      key: 'fulfilled',
      header: m.orders_lines_column_fulfilled(),
      numeric: true,
      cell: (line) => formatQuantity(line.fulfilledQuantity, line.unit),
    },
    {
      key: 'remaining',
      header: m.orders_lines_column_remaining(),
      numeric: true,
      cell: (line) =>
        line.remainingQuantity === null
          ? m.common_unknown()
          : formatQuantity(line.remainingQuantity, line.unit),
    },
  ];
}

/**
 * Chooses which source's report a section shows when the order has several sources. Sections
 * share the choice, so switching one switches all.
 */
export function SourceSwitch({
  detail,
  shown,
  choose,
  label,
}: {
  detail: OrderDetail;
  shown: OrderSourceFacts | undefined;
  choose: (connectionId: string) => void;
  label: string;
}) {
  if (detail.sources.length < 2) return null;

  return (
    <div className="order-source-switch" role="group" aria-label={label}>
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
  );
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
    <OrderSection title={m.orders_lines_title()} icon={ListOrdered}>
      <SourceSwitch
        detail={detail}
        shown={shown}
        choose={choose}
        label={m.orders_lines_source_switch()}
      />
      {shown?.lines.some((line) => line.bundleGroup === undefined) ? (
        <p className="order-note">{m.products_bundles_unknown()}</p>
      ) : null}
      {shown?.lines.some((line) => line.bundleGroup) ? (
        <p className="order-note">{m.products_bundles_note()}</p>
      ) : null}
      {shown ? (
        <DataTable
          caption={m.orders_lines_caption({ source: shown.label })}
          columns={lineColumns(organizationId, from)}
          rows={shown.lines}
          rowKey={(line) => line.id}
          density="compact"
          empty={<p className="order-note">{m.orders_lines_empty()}</p>}
        />
      ) : null}
    </OrderSection>
  );
}

type ComparedFact = {
  key: string;
  label: () => string;
  field?: string;
  authority?: AuthorityGroup;
  value: (source: OrderSourceFacts, detail: OrderDetail) => ReactNode;
};

function comparedItems(source: OrderSourceFacts) {
  const lines = source.lines
    .map((line) => ({
      ...line,
      comparedQuantity:
        line.currentQuantity ??
        (line.cancelledQuantity === null
          ? line.quantity
          : String(Number(line.quantity) - Number(line.cancelledQuantity))),
    }))
    .filter((line) => Number(line.comparedQuantity) > 0);

  return lines.length
    ? formatList(
        lines.map((line) =>
          m.orders_comparison_item({
            quantity: formatQuantity(line.comparedQuantity, line.unit),
            item: line.skuCode ?? line.title ?? m.orders_lines_untitled(),
          }),
        ),
        { type: 'unit' },
      )
    : m.common_none();
}

const comparedFacts: ComparedFact[] = [
  {
    key: 'number',
    label: m.orders_comparison_number,
    value: (source) => source.displayNumber ?? m.common_empty_value(),
  },
  {
    key: 'status',
    label: m.orders_comparison_status,
    field: 'status',
    authority: 'order_lifecycle',
    value: (source) => statusLabels[source.status] ?? source.status,
  },
  {
    key: 'payment',
    label: m.orders_comparison_payment,
    field: 'paymentStatus',
    value: (source) =>
      paymentLabels[source.paymentStatus] ?? source.paymentStatus,
  },
  {
    key: 'total',
    label: m.orders_comparison_total,
    field: 'total',
    value: (source) => formatMoney(source.total) ?? m.common_not_reported(),
  },
  {
    key: 'items',
    label: m.orders_comparison_items,
    field: 'currentQuantity',
    authority: 'order_lines',
    value: comparedItems,
  },
  {
    key: 'fulfillment',
    authority: 'order_fulfillment',
    field: 'fulfillment',
    label: m.orders_comparison_fulfillment,
    value: (source) => fulfillmentLabel(source),
  },
  {
    key: 'location',
    field: 'location',
    label: m.orders_comparison_location,
    authority: 'order_fulfillment',
    value: (source, detail) => {
      const locations = detail.fulfillments
        .filter(
          (item) => item.connectionId === source.connectionId && !item.deleted,
        )
        .map((item) => item.location?.name ?? item.location?.locationId)
        .filter((name): name is string => !!name);

      return locations.length
        ? formatList([...new Set(locations)])
        : m.common_not_reported();
    },
  },
  {
    key: 'tracking',
    label: m.orders_authority_tracking,
    authority: 'order_tracking',
    value: (source, detail) => {
      const fulfillments = detail.fulfillments.filter(
        (item) => item.connectionId === source.connectionId && !item.deleted,
      );
      const tracking = fulfillments
        .flatMap((item) => item.tracking ?? [])
        .map((item) => item.number ?? item.url ?? item.carrier)
        .filter((value): value is string => !!value);

      return tracking.length
        ? formatList(tracking)
        : fulfillments.some((item) => item.tracking !== null)
          ? m.common_none()
          : m.common_not_reported();
    },
  },
  {
    key: 'cancellation',
    field: 'cancelledQuantity',
    label: m.orders_comparison_cancelled,
    authority: 'order_lifecycle',
    value: (source) =>
      formatList(
        source.lines.map((line) =>
          line.cancelledQuantity === null
            ? m.common_not_reported()
            : formatQuantity(line.cancelledQuantity, line.unit),
        ),
        { type: 'unit' },
      ),
  },
  {
    key: 'placed',
    label: m.orders_comparison_placed,
    value: (source) =>
      source.placedAt ? (
        <WorkspaceDate value={source.placedAt} />
      ) : (
        m.common_empty_value()
      ),
  },
  {
    key: 'due',
    label: m.orders_comparison_due,
    value: (source) =>
      source.dueAt ? (
        <WorkspaceDate value={source.dueAt} />
      ) : (
        m.common_empty_value()
      ),
  },
  {
    key: 'source-updated',
    label: m.orders_comparison_source_updated,
    value: (source) =>
      source.sourceUpdatedAt ? (
        <WorkspaceDate value={source.sourceUpdatedAt} />
      ) : (
        m.common_not_reported()
      ),
  },
];

/** Compares the facts each source reports side by side and marks the fields that differ. */
export function SourceComparison({ detail }: { detail: OrderDetail }) {
  const differs = new Set<string>(detail.differences.map((item) => item.field));
  const stateLabels = {
    matching: m.orders_comparison_matching,
    pending: m.orders_comparison_pending,
    confirmed: m.orders_comparison_confirmed,
    inconclusive: m.orders_comparison_inconclusive,
  };
  const stateLabel = stateLabels[detail.order.comparisonState];
  const columns: DataTableColumn<ComparedFact>[] = [
    {
      key: 'field',
      header: m.orders_comparison_field(),
      cell: (fact) => (
        <span className="order-comparison-field">
          {fact.label()}
          {fact.field && differs.has(fact.field) ? (
            <Badge
              tone={
                detail.order.comparisonState === 'confirmed'
                  ? 'warning'
                  : 'neutral'
              }
            >
              {stateLabel()}
            </Badge>
          ) : null}
        </span>
      ),
    },
    {
      key: 'authority',
      header: m.orders_authority_title(),
      cell: (fact) =>
        fact.authority
          ? authorityLabel(
              detail.authority.groups.find(
                (group) => group.group === fact.authority,
              ),
              detail.sources.map((source) => ({
                id: source.connectionId,
                label: source.label,
              })),
            )
          : m.orders_authority_not_configured(),
    },
    ...detail.sources.map((source) => ({
      key: source.connectionId,
      header: source.deleted
        ? m.orders_source_removed({ source: source.label })
        : source.label,
      cell: (fact: ComparedFact) => fact.value(source, detail),
    })),
  ];

  return (
    <OrderSection title={m.orders_comparison_title()} icon={GitCompareArrows}>
      <p className="order-note" role="status">
        {stateLabel()}
      </p>
      {detail.order.comparisonState === 'pending' ? (
        <p className="order-note">
          {m.orders_comparison_pending_description()}
        </p>
      ) : detail.order.comparisonState === 'inconclusive' ? (
        <p className="order-note">
          {m.orders_comparison_inconclusive_description()}
        </p>
      ) : null}
      <DataTable
        caption={m.orders_comparison_caption()}
        columns={columns}
        rows={[
          ...comparedFacts,
          {
            key: 'read-at',
            label: m.orders_comparison_read_at,
            value: (source) => <WorkspaceDate value={source.observedAt} />,
          },
        ]}
        rowKey={(fact) => fact.key}
        density="compact"
      />
      <LineComparison detail={detail} />
    </OrderSection>
  );
}
