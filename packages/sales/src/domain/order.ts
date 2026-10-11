interface SalesAddress {
  name: string;
  company: string;
  street: string;
  city: string;
  postalCode: string;
  country: string;
}

export interface SalesLine {
  id: string;
  skuId: string | null;
  skuCode: string | null;
  title: string | null;
  quantity: string;
  currentQuantity: string;
  unit: string;
  unitPrice: string | null;
  taxRate: string | null;
}

export interface SalesOrder {
  id: string;
  orderId: string;
  connectionId: string;
  version: number;
  number: string;
  status: 'open' | 'completed' | 'cancelled';
  paymentStatus:
    | 'pending'
    | 'authorized'
    | 'paid'
    | 'partially_refunded'
    | 'refunded'
    | 'failed'
    | 'unknown';
  customerId: string | null;
  billingAddress: SalesAddress | null;
  shippingAddress: SalesAddress | null;
  currency: string;
  channel: string;
  total: string | null;
  placedAt: string | null;
  dueAt: string | null;
  updatedAt: string;
  lines: SalesLine[];
}

export interface SalesEdit {
  commandId: string;
  version: number;
  status?: SalesOrder['status'] | undefined;
  billingAddress?: SalesAddress | null | undefined;
  shippingAddress?: SalesAddress | null | undefined;
  lines?: { id: string; currentQuantity: string }[] | undefined;
}
const scale = 1_000_000n;

/** Parses a nonnegative fixed-point decimal without floating-point rounding. */
export function units(value: string): bigint {
  if (!/^\d{1,14}(\.\d{1,6})?$/.test(value)) throw new Error('Invalid decimal');
  const [whole, fraction = ''] = value.split('.');

  return BigInt(whole!) * scale + BigInt(fraction.padEnd(6, '0'));
}

/** Formats a fixed-point decimal for evidence publication. */
export function decimal(value: bigint): string {
  return (
    `${value / scale}.${(value % scale).toString().padStart(6, '0')}`.replace(
      /\.?0+$/,
      '',
    ) || '0'
  );
}

/** Evidence has no addresses or customer references; these remain erasable business records. */
export function publishedOrder(order: SalesOrder) {
  return {
    type: 'order' as const,
    displayNumber: order.number,
    status: order.status,
    paymentStatus: order.paymentStatus,
    placedAt: order.placedAt,
    dueAt: order.dueAt,
    total:
      order.total === null
        ? null
        : { amount: order.total, currency: order.currency },
    lines: order.lines.map((line) => ({
      id: line.id,
      skuId: line.skuId,
      skuCode: line.skuCode,
      title: line.title,
      quantity: line.quantity,
      currentQuantity:
        order.status === 'cancelled' ? '0' : line.currentQuantity,
      cancelledQuantity: decimal(
        units(line.quantity) -
          (order.status === 'cancelled' ? 0n : units(line.currentQuantity)),
      ),
      unit: line.unit,
      unitPrice:
        line.unitPrice === null
          ? null
          : { amount: line.unitPrice, currency: order.currency },
      taxRate: line.taxRate,
    })),
  };
}
