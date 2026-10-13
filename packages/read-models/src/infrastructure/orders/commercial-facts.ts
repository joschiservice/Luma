import type {
  MoneyPair,
  OrderCommercialData,
  OrderLineCommercialData,
} from '@luma/orders';
import type { SqlTransaction } from '@luma/platform';

import type {
  OrderAddress,
  OrderSourceAddresses,
} from '../../application/orders.js';
import { iso, money, object, text } from './values.js';

const flag = (value: unknown) => (typeof value === 'boolean' ? value : null);

const list = (value: unknown) => (Array.isArray(value) ? value : null);

const oneOf = <T extends string>(
  values: readonly T[],
  value: unknown,
  fallback: T,
): T =>
  typeof value === 'string' && (values as readonly string[]).includes(value)
    ? (value as T)
    : fallback;

/** Reads a stored shop and presentment amount; null unless both are present. */
function pair(value: unknown): MoneyPair | null {
  const stored = object(value);
  const shop = money(stored.shop);
  const presentment = money(stored.presentment);

  return shop && presentment ? { shop, presentment } : null;
}

const amount = (value: unknown) => ({
  original: pair(object(value).original),
  current: pair(object(value).current),
});

/**
 * Reads the commercial facts of a stored order snapshot. Groups the snapshot does not contain
 * stay absent, so earlier schema versions and sources that don't report them read as not
 * reported rather than empty.
 */
export function commercialFacts(
  data: Record<string, unknown>,
): OrderCommercialData {
  const facts: OrderCommercialData = {};
  if (data.currencies !== undefined) {
    const currencies = object(data.currencies);
    facts.currencies = {
      shop: text(currencies.shop),
      presentment: text(currencies.presentment),
    };
  }
  if (data.amounts !== undefined) {
    const amounts = object(data.amounts);
    facts.amounts = {
      subtotal: amount(amounts.subtotal),
      shipping: amount(amounts.shipping),
      discounts: amount(amounts.discounts),
      tax: amount(amounts.tax),
      duties: amount(amounts.duties),
      total: amount(amounts.total),
    };
  }
  if (data.taxesIncluded !== undefined)
    facts.taxesIncluded = flag(data.taxesIncluded);
  if (data.dutiesIncluded !== undefined)
    facts.dutiesIncluded = flag(data.dutiesIncluded);
  const taxLines = list(data.taxLines);
  if (taxLines)
    facts.taxLines = taxLines.map((value) => {
      const line = object(value);

      return {
        title: text(line.title),
        rate: text(line.rate),
        amount: pair(line.amount),
      };
    });
  const shippingLines = list(data.shippingLines);
  if (shippingLines)
    facts.shippingLines = shippingLines.map((value) => {
      const line = object(value);

      return {
        id: text(line.id),
        title: text(line.title),
        code: text(line.code),
        source: text(line.source),
        carrier: text(line.carrier),
        removed: flag(line.removed),
        original: pair(line.original),
        discounted: pair(line.discounted),
        current: pair(line.current),
      };
    });
  const discounts = list(data.discounts);
  if (discounts)
    facts.discounts = discounts.map((value) => {
      const discount = object(value);
      const reported = object(discount.value);
      const percentage =
        reported.type === 'percentage' ? text(reported.percentage) : null;
      const fixed = reported.type === 'fixed' ? money(reported.amount) : null;

      return {
        index: typeof discount.index === 'number' ? discount.index : null,
        kind: oneOf(
          ['code', 'automatic', 'manual', 'script', 'unknown'],
          discount.kind,
          'unknown',
        ),
        label: text(discount.label),
        target: oneOf(
          ['line_item', 'shipping_line', 'unknown'],
          discount.target,
          'unknown',
        ),
        allocation: oneOf(
          ['across', 'each', 'unknown'],
          discount.allocation,
          'unknown',
        ),
        value: percentage
          ? { type: 'percentage', percentage }
          : fixed
            ? { type: 'fixed', amount: fixed }
            : null,
      };
    });
  const tags = list(data.tags);
  if (tags)
    facts.tags = tags.filter((tag): tag is string => typeof tag === 'string');
  if (data.attributes !== undefined) {
    const attributes = object(data.attributes);
    facts.attributes = {
      edited: flag(attributes.edited),
      requiresShipping: flag(attributes.requiresShipping),
      test: flag(attributes.test),
      cancelReason: text(attributes.cancelReason),
      cancelledAt: iso(attributes.cancelledAt),
      closedAt: iso(attributes.closedAt),
      processedAt: iso(attributes.processedAt),
      channel: text(attributes.channel),
      fulfillmentStatus: text(attributes.fulfillmentStatus),
    };
  }

  return facts;
}

/** Reads the commercial facts of a stored order line; unreported facts stay absent. */
export function lineCommercialFacts(
  line: Record<string, unknown>,
): OrderLineCommercialData {
  const prices = object(line.prices);

  return {
    ...(line.variantTitle === undefined
      ? {}
      : { variantTitle: text(line.variantTitle) }),
    ...(line.prices === undefined
      ? {}
      : {
          prices: {
            originalUnit: pair(prices.originalUnit),
            discountedUnit: pair(prices.discountedUnit),
            totalDiscount: pair(prices.totalDiscount),
          },
        }),
    ...(line.requiresShipping === undefined
      ? {}
      : { requiresShipping: flag(line.requiresShipping) }),
    ...(typeof line.catalog === 'string'
      ? {
          catalog: oneOf(
            ['variant', 'variant_removed', 'no_product'],
            line.catalog,
            'no_product',
          ),
        }
      : {}),
  };
}

function address(value: unknown): OrderAddress | null {
  if (!value || typeof value !== 'object') return null;
  const stored = object(value);

  return {
    line1: text(stored.line1),
    line2: text(stored.line2),
    city: text(stored.city),
    region: text(stored.region),
    postalCode: text(stored.postalCode),
    country: text(stored.country),
  };
}

/**
 * Reads the addresses each source connection recorded for an order and its linked aliases,
 * keyed by connection. Connections without a record read as `not_imported`. Callers must check
 * that the reader may read customers.
 */
export async function readOrderAddresses(
  tx: SqlTransaction,
  tenantId: string,
  orderIds: string[],
  connectionIds: string[],
): Promise<Map<string, OrderSourceAddresses>> {
  const rows = (
    await tx.query<{
      connectionId: string;
      shared: boolean;
      shipping: unknown;
      billing: unknown;
      observedAt: Date;
    }>(
      `SELECT DISTINCT ON (a.connection_id) a.connection_id AS "connectionId",a.shared,a.shipping,a.billing,
        a.observed_at AS "observedAt"
       FROM connector_source_mappings m
       JOIN customer_order_addresses a ON a.tenant_id=m.tenant_id AND a.connection_id=m.connection_id
        AND a.order_scope_key=m.scope_key AND a.order_external_id=m.external_id
       WHERE m.tenant_id=$1 AND m.resource='order' AND m.canonical_id=ANY($2::uuid[])
        AND m.connection_id=ANY($3::uuid[])
       ORDER BY a.connection_id,a.observed_at DESC`,
      [tenantId, orderIds, connectionIds],
    )
  ).rows;
  const found = new Map(rows.map((row) => [row.connectionId, row]));

  return new Map(
    connectionIds.map((connectionId): [string, OrderSourceAddresses] => {
      const row = found.get(connectionId);
      if (!row) return [connectionId, { state: 'not_imported' }];
      const observedAt = row.observedAt.toISOString();

      return [
        connectionId,
        row.shared
          ? {
              state: 'shared',
              shipping: address(row.shipping),
              billing: address(row.billing),
              observedAt,
            }
          : { state: 'not_shared', observedAt },
      ];
    }),
  );
}
