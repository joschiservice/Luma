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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@luma/ui/components/primitives/dropdown-menu';
import {
  ToggleGroup,
  ToggleGroupItem,
} from '@luma/ui/components/primitives/toggle-group';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { Link } from '@tanstack/react-router';
import {
  Ellipsis,
  GitCompareArrows,
  Link2,
  ListOrdered,
  Route,
} from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';

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

/** What the reader can do with one line; each action appears in the line's menu when given. */
export interface OrderLineActions {
  /** Plans a quantity change for the line, by comparison key. */
  plan?: ((lineKey: string) => void) | undefined;
  /** Compares the line's facts across sources, by comparison key or line ID. */
  compare?: ((lineKey: string) => void) | undefined;
  /** Matches the line with a line of another source, by line ID. */
  match?: ((lineId: string) => void) | undefined;
}

/** The key that groups a line across sources, as source comparisons do. */
function lineKey(line: Pick<OrderLine, 'comparisonKey' | 'id'>) {
  return line.comparisonKey ?? line.id;
}

function catalogNote(line: OrderLine) {
  if (line.catalog === 'variant_removed')
    return m.orders_lines_variant_removed();
  if (line.catalog === 'no_product') return m.orders_lines_no_product();

  return line.skuId || !line.skuCode ? null : m.orders_lines_sku_unlinked();
}

function LineItem({
  line,
  organizationId,
  from,
  flags,
  menu,
}: {
  line: OrderLine;
  organizationId: string;
  from: string;
  flags: ReactNode;
  menu: ReactNode;
}) {
  const title = line.title ?? line.skuCode ?? m.orders_lines_untitled();
  const linked =
    line.skuId &&
    line.catalog !== 'variant_removed' &&
    line.catalog !== 'no_product';
  const details = [
    line.variantTitle,
    line.skuCode
      ? m.orders_lines_sku({ sku: line.skuCode })
      : m.orders_lines_no_sku(),
    catalogNote(line),
  ].filter(Boolean);

  return (
    <span className="orders-cell-stack order-line-item">
      {linked && line.skuId ? (
        <Link
          className="order-line-title"
          to="/app/$organizationId/products/$skuId"
          params={{ organizationId, skuId: line.skuId }}
          search={{ from }}
        >
          {title}
        </Link>
      ) : (
        <span className="order-line-title">{title}</span>
      )}
      <small>{details.join(' · ')}</small>
      {line.bundleGroup ? (
        <small>
          {m.products_bundles_group({
            title: line.bundleGroup.title,
            quantity: formatSourceNumber(line.bundleGroup.quantity),
          })}
        </small>
      ) : null}
      {flags}
      {menu}
    </span>
  );
}

/**
 * Units still to fulfill, emphasized while any remain on an open order. A closed order has no
 * fulfillment work left, so its unfulfilled units are stated without emphasis.
 */
function LineRemaining({
  line,
  open,
  note,
}: {
  line: OrderLine;
  open: boolean;
  note?: boolean;
}) {
  const remaining = line.remainingQuantity;
  if (remaining === null)
    return (
      <span className="order-muted">
        {note ? m.orders_lines_remaining_unknown() : m.common_unknown()}
      </span>
    );
  const quantity = formatQuantity(remaining, line.unit);
  const text = note ? m.orders_lines_remaining_note({ quantity }) : quantity;

  return open && Number(remaining) > 0 ? (
    <strong className="order-line-remaining">{text}</strong>
  ) : (
    text
  );
}

/**
 * Current units, with original and reduced units beneath when they say something more. Narrow
 * tables hide the remaining column, so the remaining units move beneath too.
 */
function LineQuantity({ line, open }: { line: OrderLine; open: boolean }) {
  const current = line.currentQuantity;
  const notes = [
    current === null || Number(current) !== Number(line.quantity)
      ? m.orders_lines_ordered_note({
          quantity: formatQuantity(line.quantity, line.unit),
        })
      : null,
    line.cancelledQuantity !== null && Number(line.cancelledQuantity) > 0
      ? m.orders_lines_reduced_note({
          quantity: formatQuantity(line.cancelledQuantity, line.unit),
        })
      : line.cancelledQuantity === null && current === null
        ? m.orders_lines_reduced_unknown()
        : null,
  ].filter(Boolean);

  return (
    <span className="orders-cell-stack order-line-quantity">
      <span className={current === null ? 'order-muted' : undefined}>
        {current === null
          ? m.common_not_reported()
          : formatQuantity(current, line.unit)}
      </span>
      {notes.map((note) => (
        <small key={note}>{note}</small>
      ))}
      <small className="order-line-remaining-narrow">
        <LineRemaining line={line} open={open} note />
      </small>
    </span>
  );
}

/** The unit price after discounts, with the price before discounts beneath when it differs. */
function LinePrice({ line }: { line: OrderLine }) {
  const discounted = line.prices?.discountedUnit?.shop ?? line.unitPrice;
  const original = line.prices?.originalUnit?.shop;
  if (!discounted)
    return <span className="order-muted">{m.common_not_reported()}</span>;
  const was =
    original &&
    original.currency === discounted.currency &&
    Number(original.amount) !== Number(discounted.amount)
      ? formatMoney(original)
      : null;

  return (
    <span className="orders-cell-stack">
      <span>{formatMoney(discounted)}</span>
      {was ? <small>{m.orders_lines_price_was({ amount: was })}</small> : null}
    </span>
  );
}

function LineMenu({
  line,
  label,
  actions,
}: {
  line: OrderLine;
  label: string;
  actions: OrderLineActions;
}) {
  const key = lineKey(line);
  const items = [
    actions.plan && line.comparisonKey ? (
      <DropdownMenuItem
        key="plan"
        onClick={() => actions.plan?.(line.comparisonKey ?? key)}
      >
        <Route aria-hidden="true" />
        {m.orders_lines_action_plan()}
      </DropdownMenuItem>
    ) : null,
    actions.compare ? (
      <DropdownMenuItem key="compare" onClick={() => actions.compare?.(key)}>
        <GitCompareArrows aria-hidden="true" />
        {m.orders_lines_action_compare()}
      </DropdownMenuItem>
    ) : null,
    actions.match ? (
      <DropdownMenuItem key="match" onClick={() => actions.match?.(line.id)}>
        <Link2 aria-hidden="true" />
        {m.orders_lines_action_match()}
      </DropdownMenuItem>
    ) : null,
  ].filter(Boolean);
  if (!items.length) return null;

  return (
    <span className="order-line-menu">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={m.orders_lines_actions({ item: label })}
            >
              <Ellipsis aria-hidden="true" />
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="w-auto min-w-56">
          {items}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}

const comparisonLabels = {
  matching: m.orders_comparison_matching,
  pending: m.orders_comparison_pending,
  confirmed: m.orders_comparison_confirmed,
  inconclusive: m.orders_comparison_inconclusive,
};

function lineColumns({
  detail,
  lines,
  organizationId,
  from,
  actions,
}: {
  detail: OrderDetail;
  lines: readonly OrderLine[];
  organizationId: string;
  from: string;
  actions: OrderLineActions | undefined;
}): DataTableColumn<OrderLine>[] {
  const differing = new Set(
    detail.differences.flatMap((item) => (item.lineKey ? [item.lineKey] : [])),
  );
  const state = detail.order.comparisonState;
  const several = detail.sources.length > 1;
  const open = detail.order.open !== false;
  const flags = (line: OrderLine) => {
    const badges = [
      line.comparisonKey && differing.has(line.comparisonKey) ? (
        <Badge
          key="differs"
          tone={state === 'confirmed' ? 'warning' : 'neutral'}
        >
          {comparisonLabels[state]()}
        </Badge>
      ) : null,
      several && !line.comparisonKey ? (
        <Badge key="unmatched">{m.orders_comparison_unmapped()}</Badge>
      ) : null,
    ].filter(Boolean);

    return badges.length ? (
      <span className="orders-row-flags">{badges}</span>
    ) : null;
  };
  const priced = lines.some(
    (line) => line.unitPrice || line.prices?.discountedUnit,
  );

  return [
    {
      key: 'item',
      header: m.orders_lines_column_item(),
      cell: (line) => (
        <LineItem
          line={line}
          organizationId={organizationId}
          from={from}
          flags={flags(line)}
          // Narrow tables hide the actions column, so the menu moves under the item.
          menu={
            actions ? (
              <span className="order-line-menu-narrow">
                <LineMenu
                  line={line}
                  label={
                    line.title ?? line.skuCode ?? m.orders_lines_untitled()
                  }
                  actions={actions}
                />
              </span>
            ) : null
          }
        />
      ),
    },
    ...(priced
      ? [
          {
            key: 'price',
            header: m.orders_lines_column_price(),
            numeric: true,
            hideOnNarrow: true,
            cell: (line: OrderLine) => <LinePrice line={line} />,
          },
        ]
      : []),
    {
      key: 'quantity',
      header: m.orders_lines_column_quantity(),
      numeric: true,
      cell: (line) => <LineQuantity line={line} open={open} />,
    },
    // Luma computes the total on the server from the shown price and current units.
    ...(priced
      ? [
          {
            key: 'total',
            header: m.orders_lines_column_total(),
            numeric: true,
            hideOnNarrow: true,
            cell: (line: OrderLine) =>
              line.currentTotal ? (
                formatMoney(line.currentTotal)
              ) : (
                <span className="order-muted">{m.common_unknown()}</span>
              ),
          },
        ]
      : []),
    {
      key: 'fulfilled',
      header: m.orders_lines_column_fulfilled(),
      numeric: true,
      hideOnNarrow: true,
      cell: (line) => formatQuantity(line.fulfilledQuantity, line.unit),
    },
    {
      key: 'remaining',
      header: m.orders_lines_column_remaining(),
      numeric: true,
      hideOnNarrow: true,
      cell: (line) => <LineRemaining line={line} open={open} />,
    },
    ...(actions
      ? [
          {
            key: 'actions',
            hideOnNarrow: true,
            header: (
              <span className="sr-only">{m.orders_lines_column_actions()}</span>
            ),
            cell: (line: OrderLine) => (
              <LineMenu
                line={line}
                label={line.title ?? line.skuCode ?? m.orders_lines_untitled()}
                actions={actions}
              />
            ),
          },
        ]
      : []),
  ];
}

/**
 * Chooses which source's report the order lines and charges show when the order has several
 * sources. The page shows it once, so both sections always show the same source.
 */
export function SourceSwitch({
  detail,
  shown,
  choose,
}: {
  detail: OrderDetail;
  shown: OrderSourceFacts | undefined;
  choose: (connectionId: string) => void;
}) {
  const labelId = useId();
  if (detail.sources.length < 2) return null;

  return (
    <div className="order-source-switch">
      <span id={labelId}>{m.orders_source_switch()}</span>
      <ToggleGroup
        aria-labelledby={labelId}
        value={shown ? [shown.connectionId] : []}
        onValueChange={([connectionId]) => {
          if (connectionId) choose(connectionId);
        }}
      >
        {detail.sources.map((source) => (
          <ToggleGroupItem
            key={source.connectionId}
            value={source.connectionId}
          >
            {source.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

/**
 * Shows the order lines one source reports with price, current units and their total, and
 * fulfillment progress.
 * With several sources, the page's source switch chooses `shown`, the description names it, and
 * lines that differ between sources are marked. `actions` adds a menu to each line; `footer` follows the table,
 * such as the changes Luma detected. `from` is the order path that product links return to.
 */
export function OrderLines({
  detail,
  shown,
  organizationId,
  from,
  actions,
  footer,
}: {
  detail: OrderDetail;
  shown: OrderSourceFacts | undefined;
  organizationId: string;
  from: string;
  actions?: OrderLineActions | undefined;
  footer?: ReactNode;
}) {
  const notes = [
    shown?.lineCoverage === 'partial' ? m.orders_lines_shipping_view() : null,
    shown?.lines.some((line) => line.bundleGroup)
      ? m.products_bundles_note()
      : null,
    shown?.lines.some((line) => line.bundleGroup === undefined)
      ? m.products_bundles_unknown()
      : null,
  ].filter((note) => note !== null);

  return (
    <OrderSection
      title={m.orders_lines_title()}
      icon={ListOrdered}
      description={
        shown && detail.sources.length > 1
          ? m.orders_section_source({ source: shown.label })
          : undefined
      }
    >
      <div className="order-lines">
        {shown ? (
          <DataTable
            caption={m.orders_lines_caption({ source: shown.label })}
            columns={lineColumns({
              detail,
              lines: shown.lines,
              organizationId,
              from,
              actions,
            })}
            rows={shown.lines}
            rowKey={(line) => line.id}
            density="compact"
            empty={<p className="order-note">{m.orders_lines_empty()}</p>}
          />
        ) : null}
        {footer}
        {notes.length ? (
          <ul className="order-footnotes">
            {notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        ) : null}
      </div>
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

/**
 * Compares the facts each source reports side by side. The facts that differ come first; the
 * reader can show every compared fact with each mapped line's business state.
 */
export function SourceComparison({ detail }: { detail: OrderDetail }) {
  const [all, setAll] = useState(false);
  const differs = new Set<string>(detail.differences.map((item) => item.field));
  const state = detail.order.comparisonState;
  const stateLabel = comparisonLabels[state];
  const facts: ComparedFact[] = [
    ...comparedFacts,
    {
      key: 'read-at',
      label: m.orders_comparison_read_at,
      value: (source) => <WorkspaceDate value={source.observedAt} />,
    },
  ];
  const differing = facts.filter(
    (fact) => fact.field && differs.has(fact.field),
  );
  const rows = all ? facts : differing;
  const columns: DataTableColumn<ComparedFact>[] = [
    {
      key: 'field',
      header: m.orders_comparison_field(),
      cell: (fact) => (
        <span className="order-comparison-field">
          {fact.label()}
          {fact.field && differs.has(fact.field) ? (
            <Badge tone={state === 'confirmed' ? 'warning' : 'neutral'}>
              {stateLabel()}
            </Badge>
          ) : null}
        </span>
      ),
    },
    {
      key: 'authority',
      header: m.orders_authority_title(),
      hideOnNarrow: true,
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
    <OrderSection
      title={m.orders_comparison_title()}
      icon={GitCompareArrows}
      action={
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={all}
          onClick={() => setAll((current) => !current)}
        >
          {all
            ? m.orders_comparison_show_differences()
            : m.orders_comparison_show_all({ count: facts.length })}
        </Button>
      }
    >
      <div className="order-comparison">
        <p className="order-comparison-state" role="status">
          <Badge
            tone={
              state === 'confirmed'
                ? 'warning'
                : state === 'matching'
                  ? 'success'
                  : 'neutral'
            }
          >
            {stateLabel()}
          </Badge>
          <span>
            {state === 'pending'
              ? m.orders_comparison_pending_description()
              : state === 'inconclusive'
                ? m.orders_comparison_inconclusive_description()
                : state === 'matching'
                  ? m.orders_comparison_matching_description()
                  : m.orders_comparison_confirmed_description()}
          </span>
        </p>
        {rows.length ? (
          <DataTable
            caption={m.orders_comparison_caption()}
            columns={columns}
            rows={rows}
            rowKey={(fact) => fact.key}
            density="compact"
          />
        ) : null}
        {all ? <LineComparison detail={detail} /> : null}
      </div>
    </OrderSection>
  );
}
