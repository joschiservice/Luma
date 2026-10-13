import type { OrderDetail, OrderSourceFacts } from '@luma/api-contract';
import { formatPercent } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Badge } from '@luma/ui/components/primitives/badge';
import {
  DataTable,
  type DataTableColumn,
} from '@luma/ui/components/primitives/data-table';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { Receipt } from 'lucide-react';
import { type ReactNode, useId } from 'react';

import { OrderSection } from '../../shared/orders/order-section';
import { formatMoney } from '../../shared/orders/presentation';
import { SourceSwitch } from './source-facts';

type Amounts = NonNullable<OrderSourceFacts['amounts']>;

type Pair = Amounts['total']['current'];

type ShippingLine = NonNullable<OrderSourceFacts['shippingLines']>[number];

type Discount = NonNullable<OrderSourceFacts['discounts']>[number];

type TaxLine = NonNullable<OrderSourceFacts['taxLines']>[number];

type Address = Extract<
  NonNullable<OrderSourceFacts['addresses']>,
  { state: 'shared' }
>['shipping'];

const amountRows = [
  { key: 'subtotal', label: m.orders_amounts_subtotal },
  { key: 'shipping', label: m.orders_amounts_shipping },
  { key: 'discounts', label: m.orders_amounts_discounts },
  { key: 'tax', label: m.orders_amounts_tax },
  { key: 'duties', label: m.orders_amounts_duties },
  { key: 'total', label: m.orders_amounts_total },
] as const;

const cancelReasons: Record<string, () => string> = {
  customer: m.orders_cancel_reason_customer,
  declined: m.orders_cancel_reason_declined,
  fraud: m.orders_cancel_reason_fraud,
  inventory: m.orders_cancel_reason_inventory,
  staff: m.orders_cancel_reason_staff,
  other: m.orders_cancel_reason_other,
  unknown: m.orders_cancel_reason_unknown,
};

const sourceFulfillment: Record<string, () => string> = {
  unfulfilled: m.orders_source_fulfillment_unfulfilled,
  partially_fulfilled: m.orders_source_fulfillment_partially_fulfilled,
  fulfilled: m.orders_source_fulfillment_fulfilled,
  restocked: m.orders_source_fulfillment_restocked,
  pending_fulfillment: m.orders_source_fulfillment_pending_fulfillment,
  open: m.orders_source_fulfillment_open,
  in_progress: m.orders_source_fulfillment_in_progress,
  on_hold: m.orders_source_fulfillment_on_hold,
  scheduled: m.orders_source_fulfillment_scheduled,
  request_declined: m.orders_source_fulfillment_request_declined,
};

const discountKinds: Record<Discount['kind'], () => string> = {
  code: m.orders_discount_kind_code,
  automatic: m.orders_discount_kind_automatic,
  manual: m.orders_discount_kind_manual,
  script: m.orders_discount_kind_script,
  unknown: m.orders_discount_kind_unknown,
};

const discountTargets: Record<Discount['target'], () => string> = {
  line_item: m.orders_discount_target_line_item,
  shipping_line: m.orders_discount_target_shipping_line,
  unknown: m.common_unknown,
};

/** Formats a fractional decimal string, such as `0.19`, as a percentage. */
function rate(value: string | null) {
  const ratio = value === null ? Number.NaN : Number(value);

  return Number.isFinite(ratio)
    ? formatPercent(ratio, { maximumFractionDigits: 4 })
    : null;
}

/** The shop amount, with the charged amount beneath it when the customer paid in another currency. */
function Money({ pair, missing }: { pair: Pair; missing: string }) {
  if (!pair) return <span className="order-muted">{missing}</span>;
  const presented = pair.presentment.currency !== pair.shop.currency;

  return (
    <span className="orders-cell-stack">
      <span>{formatMoney(pair.shop)}</span>
      {presented ? (
        <small>
          {m.orders_amounts_presented({
            amount: formatMoney(pair.presentment) ?? '',
          })}
        </small>
      ) : null}
    </span>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function flag(value: boolean | null | undefined, missing: string) {
  return value === true
    ? m.common_yes()
    : value === false
      ? m.common_no()
      : missing;
}

function addressLines(address: Address) {
  if (!address) return null;
  const locality = [address.postalCode, address.city].filter(Boolean).join(' ');
  const lines = [
    address.line1,
    address.line2,
    locality || null,
    [address.region, address.country].filter(Boolean).join(', ') || null,
  ].filter((line): line is string => !!line);

  return lines.length ? lines : null;
}

function AddressValue({ address }: { address: Address }) {
  const lines = addressLines(address);

  return lines ? (
    lines.map((line) => (
      <span className="order-address-line" key={line}>
        {line}
      </span>
    ))
  ) : (
    <span className="order-muted">{m.common_none()}</span>
  );
}

/** States what the reader can know about the shown source's addresses. */
function Addresses({
  detail,
  source,
}: {
  detail: OrderDetail;
  source: OrderSourceFacts;
}) {
  const heading = useId();
  const addresses = source.addresses;
  let content: ReactNode;
  if (detail.hidden.includes('addresses') || !addresses)
    content = <p className="order-note">{m.orders_addresses_restricted()}</p>;
  else if (addresses.state === 'not_shared')
    content = (
      <p className="order-note">
        {m.orders_addresses_not_shared({ source: source.label })}
      </p>
    );
  else if (addresses.state === 'not_imported')
    content = (
      <p className="order-note">
        {m.orders_addresses_not_imported({ source: source.label })}
      </p>
    );
  else
    content = (
      <dl className="order-facts">
        <Fact label={m.orders_addresses_shipping()}>
          <AddressValue address={addresses.shipping} />
        </Fact>
        <Fact label={m.orders_addresses_billing()}>
          <AddressValue address={addresses.billing} />
        </Fact>
      </dl>
    );

  return (
    <section className="order-charges-group" aria-labelledby={heading}>
      <h3 id={heading}>{m.orders_addresses_title()}</h3>
      {content}
    </section>
  );
}

/**
 * One group of charge facts. A group the source does not report says so, so it never reads as
 * an empty list.
 */
function Group({
  title,
  missing,
  children,
}: {
  title: string;
  missing: string | null;
  children: ReactNode;
}) {
  const heading = useId();

  return (
    <section className="order-charges-group" aria-labelledby={heading}>
      <h3 id={heading}>{title}</h3>
      {missing === null ? children : <p className="order-note">{missing}</p>}
    </section>
  );
}

function amountColumns(missing: string) {
  return [
    {
      key: 'amount',
      header: m.orders_amounts_column_amount(),
      cell: (row) => row.label(),
    },
    {
      key: 'original',
      header: m.orders_amounts_column_original(),
      numeric: true,
      cell: (row) => <Money pair={row.value.original} missing={missing} />,
    },
    {
      key: 'current',
      header: m.orders_amounts_column_current(),
      numeric: true,
      cell: (row) => <Money pair={row.value.current} missing={missing} />,
    },
  ] satisfies DataTableColumn<{
    key: string;
    label: () => string;
    value: Amounts['total'];
  }>[];
}

function shippingColumns(missing: string): DataTableColumn<ShippingLine>[] {
  return [
    {
      key: 'charge',
      header: m.orders_shipping_column_charge(),
      cell: (line) => (
        <span className="orders-cell-stack">
          <span className="order-charge-title">
            {line.title ?? line.code ?? m.orders_shipping_untitled()}
            {line.removed ? (
              <Badge tone="warning">{m.orders_shipping_removed()}</Badge>
            ) : null}
          </span>
          {line.code && line.title ? <small>{line.code}</small> : null}
        </span>
      ),
    },
    {
      key: 'carrier',
      header: m.orders_shipping_column_carrier(),
      hideOnNarrow: true,
      cell: (line) =>
        line.carrier ?? <span className="order-muted">{missing}</span>,
    },
    {
      key: 'original',
      header: m.orders_shipping_column_original(),
      numeric: true,
      cell: (line) => <Money pair={line.original} missing={missing} />,
    },
    {
      key: 'current',
      header: m.orders_shipping_column_current(),
      numeric: true,
      cell: (line) => <Money pair={line.current} missing={missing} />,
    },
  ];
}

function discountValue(discount: Discount) {
  const value = discount.value;
  if (!value) return null;
  if (value.type === 'percentage') {
    const percentage = Number(value.percentage);

    return Number.isFinite(percentage)
      ? formatPercent(percentage / 100, { maximumFractionDigits: 4 })
      : null;
  }
  const amount = formatMoney(value.amount) ?? '';

  return discount.allocation === 'each'
    ? m.orders_discount_value_each({ amount })
    : amount;
}

function discountColumns(missing: string): DataTableColumn<Discount>[] {
  return [
    {
      key: 'discount',
      header: m.orders_discounts_column_discount(),
      cell: (discount) => (
        <span className="orders-cell-stack">
          <span>{discount.label ?? m.orders_discounts_untitled()}</span>
          <small>{discountKinds[discount.kind]()}</small>
        </span>
      ),
    },
    {
      key: 'target',
      header: m.orders_discounts_column_target(),
      cell: (discount) => discountTargets[discount.target](),
    },
    {
      key: 'value',
      header: m.orders_discounts_column_value(),
      numeric: true,
      cell: (discount) =>
        discountValue(discount) ?? (
          <span className="order-muted">{missing}</span>
        ),
    },
  ];
}

function taxColumns(missing: string): DataTableColumn<TaxLine>[] {
  return [
    {
      key: 'tax',
      header: m.orders_tax_column_tax(),
      cell: (line) => line.title ?? m.orders_tax_untitled(),
    },
    {
      key: 'rate',
      header: m.orders_tax_column_rate(),
      numeric: true,
      cell: (line) =>
        rate(line.rate) ?? <span className="order-muted">{missing}</span>,
    },
    {
      key: 'amount',
      header: m.orders_tax_column_amount(),
      numeric: true,
      cell: (line) => <Money pair={line.amount} missing={missing} />,
    },
  ];
}

/**
 * Shows the delivery, commercial and operational facts one source reports for the order:
 * currencies, amounts as placed and current, shipping charges, discounts, tax lines, tags,
 * operational attributes and addresses. Groups the source does not report say so.
 */
export function OrderCharges({
  detail,
  shown,
  choose,
}: {
  detail: OrderDetail;
  shown: OrderSourceFacts | undefined;
  choose: (connectionId: string) => void;
}) {
  if (!shown) return null;
  const source = shown.label;
  const missing = m.orders_charges_not_reported({ source });
  const notReported = (reported: boolean) => (reported ? null : missing);
  const { attributes, currencies, amounts } = shown;
  const reportsNothing =
    !currencies &&
    !amounts &&
    !shown.shippingLines &&
    !shown.discounts &&
    !shown.taxLines &&
    !shown.tags &&
    !attributes &&
    shown.taxesIncluded === undefined;

  return (
    <OrderSection title={m.orders_charges_title()} icon={Receipt}>
      <SourceSwitch
        detail={detail}
        shown={shown}
        choose={choose}
        label={m.orders_charges_source_switch()}
      />
      <div className="order-charges">
        <dl className="order-facts">
          <Fact label={m.orders_charges_read_at()}>
            <WorkspaceDate value={shown.observedAt} />
          </Fact>
          <Fact label={m.orders_charges_source_updated()}>
            {shown.sourceUpdatedAt ? (
              <WorkspaceDate value={shown.sourceUpdatedAt} />
            ) : (
              <span className="order-muted">{missing}</span>
            )}
          </Fact>
        </dl>
        {reportsNothing ? (
          <p className="order-note">
            {m.orders_charges_none_reported({ source })}
          </p>
        ) : (
          <>
            <dl className="order-facts">
              <Fact label={m.orders_charges_currency()}>
                {currencies?.shop ? (
                  currencies.presentment &&
                  currencies.presentment !== currencies.shop ? (
                    m.orders_charges_currency_presented({
                      shop: currencies.shop,
                      presentment: currencies.presentment,
                    })
                  ) : (
                    currencies.shop
                  )
                ) : (
                  <span className="order-muted">{missing}</span>
                )}
              </Fact>
              <Fact label={m.orders_charges_taxes_included()}>
                {flag(shown.taxesIncluded, missing)}
              </Fact>
              <Fact label={m.orders_charges_duties_included()}>
                {flag(shown.dutiesIncluded, missing)}
              </Fact>
              <Fact label={m.orders_charges_channel()}>
                {attributes?.channel ?? (
                  <span className="order-muted">{missing}</span>
                )}
              </Fact>
              <Fact label={m.orders_charges_tags()}>
                {!shown.tags ? (
                  <span className="order-muted">{missing}</span>
                ) : shown.tags.length ? (
                  <span className="order-tags">
                    {shown.tags.map((tag) => (
                      <Badge key={tag}>{tag}</Badge>
                    ))}
                  </span>
                ) : (
                  m.common_none()
                )}
              </Fact>
              <Fact label={m.orders_charges_test()}>
                {attributes?.test ? (
                  <Badge tone="warning">{m.common_yes()}</Badge>
                ) : (
                  flag(attributes?.test, missing)
                )}
              </Fact>
              <Fact label={m.orders_charges_edited()}>
                {flag(attributes?.edited, missing)}
              </Fact>
              <Fact label={m.orders_charges_requires_shipping()}>
                {flag(attributes?.requiresShipping, missing)}
              </Fact>
              <Fact label={m.orders_charges_source_fulfillment()}>
                {attributes?.fulfillmentStatus ? (
                  (sourceFulfillment[attributes.fulfillmentStatus]?.() ??
                  attributes.fulfillmentStatus)
                ) : (
                  <span className="order-muted">{missing}</span>
                )}
              </Fact>
              <Fact label={m.orders_charges_processed()}>
                {attributes?.processedAt ? (
                  <WorkspaceDate value={attributes.processedAt} />
                ) : (
                  <span className="order-muted">{missing}</span>
                )}
              </Fact>
              {attributes?.closedAt ? (
                <Fact label={m.orders_charges_closed()}>
                  <WorkspaceDate value={attributes.closedAt} />
                </Fact>
              ) : null}
              {attributes?.cancelledAt ? (
                <Fact label={m.orders_charges_cancelled()}>
                  <WorkspaceDate value={attributes.cancelledAt} />
                </Fact>
              ) : null}
              {attributes?.cancelReason ? (
                <Fact label={m.orders_charges_cancel_reason()}>
                  {cancelReasons[attributes.cancelReason]?.() ??
                    attributes.cancelReason}
                </Fact>
              ) : null}
            </dl>
            <Group
              title={m.orders_amounts_title()}
              missing={notReported(!!amounts)}
            >
              {amounts ? (
                <DataTable
                  caption={m.orders_amounts_caption({ source })}
                  columns={amountColumns(missing)}
                  rows={amountRows.map((row) => ({
                    ...row,
                    value: amounts[row.key],
                  }))}
                  rowKey={(row) => row.key}
                  density="compact"
                />
              ) : null}
            </Group>
            <Group
              title={m.orders_shipping_title()}
              missing={notReported(!!shown.shippingLines)}
            >
              <DataTable
                caption={m.orders_shipping_caption({ source })}
                columns={shippingColumns(missing)}
                rows={shown.shippingLines ?? []}
                rowKey={(line) =>
                  line.id ?? `${line.title}:${line.code}:${line.removed}`
                }
                density="compact"
                empty={
                  <p className="order-note">{m.orders_shipping_empty()}</p>
                }
              />
            </Group>
            <Group
              title={m.orders_discounts_title()}
              missing={notReported(!!shown.discounts)}
            >
              <DataTable
                caption={m.orders_discounts_caption({ source })}
                columns={discountColumns(missing)}
                rows={shown.discounts ?? []}
                rowKey={(discount) =>
                  `${discount.index ?? ''}:${discount.kind}:${discount.label ?? ''}`
                }
                density="compact"
                empty={
                  <p className="order-note">{m.orders_discounts_empty()}</p>
                }
              />
            </Group>
            <Group
              title={m.orders_tax_title()}
              missing={notReported(!!shown.taxLines)}
            >
              <DataTable
                caption={m.orders_tax_caption({ source })}
                columns={taxColumns(missing)}
                rows={shown.taxLines ?? []}
                rowKey={(line) => `${line.title ?? ''}:${line.rate ?? ''}`}
                density="compact"
                empty={<p className="order-note">{m.orders_tax_empty()}</p>}
              />
            </Group>
          </>
        )}
        <Addresses detail={detail} source={shown} />
      </div>
    </OrderSection>
  );
}
