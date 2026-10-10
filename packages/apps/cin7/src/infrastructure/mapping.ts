import {
  ConnectorError,
  type CustomerSnapshot,
  type ExternalId,
  type FulfillmentSnapshot,
  type OrderSnapshot,
  type ProductSnapshot,
  type RefundSnapshot,
  type SupplierOrderSnapshot,
  type SupplierSnapshot,
} from '@luma/connections';
import type * as s from '@luma/connector-cin7/schemas';
import type { z } from 'zod';

import { unitOf } from './units.js';

type Sale = z.infer<typeof s.sale>;

type Units = (productId: string) => string;

/** A source reference; Cin7 GUIDs are account-wide, so only line references have a scope. */
export const ref = (externalId: string, scopeKey = ''): ExternalId => ({
  externalId,
  scopeKey,
});

/** Source text, or null when blank or longer than `max`; text is never truncated. */
export const text = (value: string | null | undefined, max = 512) => {
  const trimmed = value?.trim();

  return trimmed && trimmed.length <= max ? trimmed : null;
};

const invalid = () =>
  new ConnectorError({
    code: 'invalid_response',
    effect: 'none',
    retry: 'never',
  });

const scale = 1_000_000n;

const toMicros = (value: string) => {
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = value.replace('-', '').split('.');
  const micros = BigInt(whole!) * scale + BigInt(fraction.padEnd(6, '0'));

  return negative ? -micros : micros;
};

const fromMicros = (value: bigint) => {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const fraction = (absolute % scale)
    .toString()
    .padStart(6, '0')
    .replace(/0+$/, '');

  return `${negative ? '-' : ''}${absolute / scale}${fraction ? `.${fraction}` : ''}`;
};

/** Adds exact decimal strings. */
export const sum = (values: string[]) =>
  fromMicros(values.reduce((total, value) => total + toMicros(value), 0n));

const positive = (value: string) => toMicros(value) > 0n;

/** A Cin7 document line: lines carry no ID, only the product they refer to. */
interface Line {
  ProductID?: string | null | undefined;
  SKU?: string | null | undefined;
  Name?: string | null | undefined;
  Quantity: string;
}

/**
 * Sums a document's lines per product. Cin7 lines have no ID, so a product identifies its line
 * within the sale or purchase; lines without a product, such as charges, are not product lines.
 */
export function byProduct(lines: Line[]) {
  const result = new Map<
    string,
    { quantity: string; sku: string | null; name: string | null }
  >();
  for (const line of lines) {
    if (!line.ProductID) continue;
    const prior = result.get(line.ProductID);
    result.set(line.ProductID, {
      quantity: prior ? sum([prior.quantity, line.Quantity]) : line.Quantity,
      sku: prior?.sku ?? text(line.SKU),
      name: prior?.name ?? text(line.Name),
    });
  }

  return result;
}

const orderStatuses = new Set([
  'AUTHORISED',
  'AUTH_NO_ALLOC',
  'FULFILLED',
  'CLOSED',
  'VOIDED',
]);

/**
 * Whether a sale has reached its order stage. Quotes and draft orders are not orders yet;
 * a voided sale counts when its order had been authorised.
 */
export const isOrder = (orderStatus: string | null | undefined) =>
  orderStatuses.has(orderStatus ?? '');

const money = (amount: string | null | undefined, currency: string | null) =>
  amount != null && currency && /^[A-Z]{3}$/.test(currency)
    ? { amount, currency }
    : null;

/** Maps a sale at its order stage to Luma's order. */
export function orderSnapshot(
  sale: Sale,
  units: Units,
  customers: boolean,
): OrderSnapshot {
  const lines = byProduct(sale.Order?.Lines ?? []);

  return {
    displayNumber: text(sale.Order?.SaleOrderNumber),
    // A channel sale's customer reference is the marketplace order number; otherwise it is
    // the customer's own reference, which never suggests a link.
    externalOrderNumber: text(sale.SourceChannel)
      ? text(sale.CustomerReference)
      : null,
    dueAt: sale.ShipBy ?? null,
    placedAt: sale.SaleOrderDate ?? null,
    total: money(sale.Order?.Total, sale.CustomerCurrency ?? null),
    ...(customers
      ? { customer: sale.CustomerID ? ref(sale.CustomerID) : null }
      : {}),
    status:
      sale.Status === 'VOIDED' || sale.Order?.Status === 'VOIDED'
        ? 'cancelled'
        : sale.Status === 'COMPLETED' ||
            sale.FulFilmentStatus === 'FULFILLED' ||
            ['FULFILLED', 'CLOSED'].includes(sale.Order?.Status ?? '')
          ? 'completed'
          : 'open',
    paymentStatus: ['PAID', 'PREPAID'].includes(
      sale.CombinedPaymentStatus ?? '',
    )
      ? 'paid'
      : sale.CombinedPaymentStatus === 'UNPAID'
        ? 'pending'
        : 'unknown',
    lines: [...lines]
      .filter(([, line]) => positive(line.quantity))
      .map(([productId, line]) => ({
        id: ref(productId, sale.ID),
        sku: ref(productId),
        quantity: { amount: line.quantity, unit: units(productId) },
        // Cin7 reports changed order quantities, not what was cancelled.
        cancelledQuantity: null,
        skuCode: line.sku,
        title: line.name,
      })),
  };
}

// Only absolute web links are kept; anything else is treated as not provided.
const link = (value: string | null | undefined) => {
  const url = value?.trim();
  if (!url || url.length > 2048) return null;
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol) ? url : null;
  } catch {
    return null;
  }
};

const latest = (values: (string | null | undefined)[]) =>
  values
    .filter((value): value is string => !!value)
    .reduce<string | null>(
      (a, b) => (a === null || Date.parse(b) > Date.parse(a) ? b : a),
      null,
    );

/**
 * Maps each fulfilment of a sale to Luma's fulfillment. Lines come from the pick, or the pack
 * before a pick exists; a line for a product the order doesn't contain rejects the page.
 */
export function fulfillmentSnapshots(
  sale: Sale,
  units: Units,
): { id: string; data: FulfillmentSnapshot }[] {
  const ordered = byProduct(sale.Order?.Lines ?? []);

  return sale.Fulfilments.map((fulfilment) => {
    const steps = [fulfilment.Pick, fulfilment.Pack, fulfilment.Ship];
    const status: FulfillmentSnapshot['status'] =
      fulfilment.FulFilmentStatus === 'VOIDED' ||
      steps.some((step) => step?.Status === 'VOIDED')
        ? 'cancelled'
        : fulfilment.Ship?.Status === 'AUTHORISED'
          ? 'shipped'
          : steps.some((step) =>
                ['DRAFT', 'AUTHORISED', 'PARTIALLY AUTHORISED'].includes(
                  step?.Status ?? '',
                ),
              )
            ? 'processing'
            : 'pending';
    const source = fulfilment.Pick?.Lines.length
      ? fulfilment.Pick.Lines
      : (fulfilment.Pack?.Lines ?? []);
    const lines = [...byProduct(source)]
      .filter(([, line]) => positive(line.quantity))
      .map(([productId, line]) => {
        if (!ordered.has(productId)) throw invalid();

        return {
          orderLine: ref(productId, sale.ID),
          quantity: { amount: line.quantity, unit: units(productId) },
        };
      });
    const locations = new Map(
      source.flatMap((line) =>
        line.LocationID ? [[line.LocationID, text(line.Location)]] : [],
      ),
    );
    const shipments = (fulfilment.Ship?.Lines ?? []).filter(
      (line) => line.IsShipped !== false,
    );
    const tracking = new Map<
      string,
      { carrier: string | null; number: string | null; url: string | null }
    >();
    for (const line of shipments) {
      const entry = {
        carrier: text(line.Carrier),
        number: text(line.TrackingNumber),
        url: link(line.TrackingURL),
      };
      if (entry.number || entry.url) tracking.set(JSON.stringify(entry), entry);
    }
    const [location] = locations;

    return {
      id: fulfilment.TaskID,
      data: {
        order: ref(sale.ID),
        status,
        lines,
        // Fulfilments have no time of their own: shipment dates once shipped, otherwise the
        // sale's last change.
        lastProgressAt:
          (status === 'shipped'
            ? latest(shipments.map((line) => line.ShipmentDate))
            : null) ??
          sale.LastModifiedOn ??
          null,
        progressBasis: 'source_updated',
        failureCode: null,
        location:
          locations.size === 1 && location
            ? { id: ref(location[0]), name: location[1] }
            : null,
        fulfillBy: fulfilment.Ship?.RequireBy ?? sale.ShipBy ?? null,
        tracking: [...tracking.values()],
      },
    };
  });
}

/**
 * Maps a sale's authorised and voided credit notes to refunds; drafts are not refunds yet.
 * Refund payments recorded in Cin7 count as money returned. Credit lines for products the
 * order doesn't contain are not refund lines.
 */
export function refundSnapshots(
  sale: Sale,
  units: Units,
): { id: string; voided: boolean; data: RefundSnapshot }[] {
  const ordered = byProduct(sale.Order?.Lines ?? []);
  const currency = sale.CustomerCurrency ?? null;

  return sale.CreditNotes.filter((note) =>
    ['AUTHORISED', 'VOIDED'].includes(note.Status ?? ''),
  ).map((note) => {
    const restocked = byProduct(note.Restock);

    return {
      id: note.TaskID,
      voided: note.Status === 'VOIDED',
      data: {
        type: 'refund',
        order: ref(sale.ID),
        return: null,
        createdAt: note.CreditNoteDate ?? null,
        total: money(note.Total, currency),
        lines: [...byProduct(note.Lines)]
          .filter(
            ([productId, line]) =>
              ordered.has(productId) && positive(line.quantity),
          )
          .map(([productId, line]) => {
            const back = restocked.get(productId);
            const returned = !!back && positive(back.quantity);

            return {
              orderLine: ref(productId, sale.ID),
              quantity: { amount: line.quantity, unit: units(productId) },
              restock: returned ? 'return' : 'no_restock',
              restocked: returned,
            };
          }),
        transactions: note.Refunds.map((refund) => {
          const amount = money(refund.Amount, currency);
          if (!amount) throw invalid();

          return {
            status: 'success',
            amount,
            processedAt: refund.DatePaid ?? null,
            gateway: null,
          };
        }),
      },
    };
  });
}

/** Maps a Cin7 product, which is one SKU; product families are not read. */
export function productSnapshot(
  product: z.infer<typeof s.product>,
): ProductSnapshot {
  return {
    title: text(product.Name),
    status:
      product.Status === 'Active'
        ? 'active'
        : product.Status === 'Deprecated'
          ? 'archived'
          : product.Status === 'Setup required'
            ? 'draft'
            : 'unknown',
    vendor: text(product.Brand),
    skus: [
      {
        id: ref(product.ID),
        code: text(product.SKU),
        unit: unitOf(product.UOM),
        title: null,
        // Unused price tiers read as zero, so zero means no price. Tier prices carry no currency.
        price:
          product.PriceTier1 && product.PriceTier1 !== '0'
            ? { amount: product.PriceTier1, currency: null }
            : null,
        barcode: text(product.Barcode),
      },
    ],
  };
}

type Contact = NonNullable<z.infer<typeof s.customer>['Contacts']>[number];

const defaultContact = (contacts: Contact[] | null | undefined) =>
  contacts?.find((contact) => contact.Default) ?? contacts?.[0] ?? null;

/**
 * Maps a Cin7 customer. Contact details come from the default contact and the address from the
 * default shipping, business or billing address, in that order. Cin7 has no separate consent for
 * contact and address data, so the connection's customer grant shares both.
 */
export function customerSnapshot(
  customer: z.infer<typeof s.customer>,
): CustomerSnapshot {
  const contact = defaultContact(customer.Contacts);
  const addresses = customer.Addresses ?? [];
  const chosen =
    ['Shipping', 'Business', 'Billing']
      .map(
        (type) =>
          addresses.find((a) => a.Type === type && a.DefaultForType) ??
          addresses.find((a) => a.Type === type),
      )
      .find(Boolean) ??
    addresses[0] ??
    null;
  const address = chosen && {
    line1: text(chosen.Line1),
    line2: text(chosen.Line2),
    city: text(chosen.City, 256),
    region: text(chosen.State, 256),
    postalCode: text(chosen.Postcode, 64),
    country: text(chosen.Country, 128),
  };

  return {
    displayName: text(customer.DisplayName) ?? text(customer.Name),
    email: text(contact?.Email, 320),
    phone: text(contact?.Phone, 100) ?? text(contact?.MobilePhone, 100),
    address: address && Object.values(address).some(Boolean) ? address : null,
    state: customer.Status === 'Deprecated' ? 'disabled' : 'enabled',
    createdAt: null,
    orderCount: null,
    amountSpent: null,
    tags: [
      ...new Set(
        (customer.Tags ?? '')
          .split(',')
          .map((tag) => tag.trim())
          .filter((tag) => tag.length > 0 && tag.length <= 255),
      ),
    ].slice(0, 250),
    shared: { contact: true, address: true },
  };
}

/** Maps a Cin7 supplier; Cin7 has no supplier number. */
export function supplierSnapshot(
  supplier: z.infer<typeof s.supplier>,
): SupplierSnapshot {
  const email = text(defaultContact(supplier.Contacts)?.Email, 320);

  return {
    name: text(supplier.Name),
    number: null,
    active: supplier.Status === 'Active',
    email: email && email.length >= 3 ? email : null,
  };
}

const date = (value: string | null | undefined) => value?.slice(0, 10) ?? null;

/**
 * Maps a Cin7 purchase. Delivered quantities are units on authorised stock receipts. Cin7
 * records no supplier confirmation, and a voided purchase has no matching Luma status.
 */
export function purchaseSnapshot(
  purchase: z.infer<typeof s.purchase>,
  units: Units,
): SupplierOrderSnapshot {
  const received = byProduct(
    purchase.StockReceived.filter(
      (receipt) => receipt.Status === 'AUTHORISED',
    ).flatMap((receipt) => receipt.Lines.filter((line) => line.Received)),
  );
  const requested = date(purchase.RequiredBy);

  return {
    supplier: ref(purchase.SupplierID),
    orderNumber: text(purchase.OrderNumber),
    lumaOrderId: null,
    status:
      purchase.Status === 'VOIDED'
        ? 'unknown'
        : purchase.CombinedReceivingStatus === 'FULLY RECEIVED'
          ? 'completed'
          : purchase.CombinedReceivingStatus === 'PARTIALLY RECEIVED'
            ? 'partially_delivered'
            : ['DRAFT', 'ORDERING'].includes(purchase.Status)
              ? 'open'
              : purchase.Order?.Status === 'AUTHORISED'
                ? 'released'
                : 'unknown',
    requestedDeliveryDate: requested,
    confirmed: null,
    createdAt: purchase.OrderDate ?? null,
    lines: [...byProduct(purchase.Order?.Lines ?? [])]
      .filter(([, line]) => positive(line.quantity))
      .map(([productId, line]) => ({
        id: ref(productId, purchase.ID),
        sku: ref(productId),
        itemNumber: line.sku,
        quantity: { amount: line.quantity, unit: units(productId) },
        deliveredQuantity: received.get(productId)?.quantity ?? '0',
        confirmedQuantity: null,
        confirmedDeliveryDate: null,
        confirmed: null,
        requestedDeliveryDate: requested,
      })),
  };
}
