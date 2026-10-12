import {
  decimalQuantity,
  LedgerError,
  nextStockVersion,
  quantityUnits,
} from './ledger.js';

/** An allocation retains exact remaining units; terminal records never regain stock. */
export interface StockReservation {
  id: string;
  orderId: string;
  orderLineId: string;
  skuId: string;
  locationId: string;
  unit: string;
  version: string;
  allocated: string;
  remaining: string;
  consumed: string;
  released: string;
  expiresAt: string | null;
  state: 'active' | 'released' | 'consumed' | 'expired';
  createdAt: string;
  updatedAt: string;
}

/** Computes a bounded allocation without inventing stock or oversubscribing the order's outstanding demand. */
export function allocationQuantity(
  requested: string,
  available: string,
  outstanding: string,
  alreadyReserved: string,
) {
  const wanted = quantityUnits(requested),
    free = quantityUnits(available),
    demand = quantityUnits(outstanding) - quantityUnits(alreadyReserved);
  if (wanted <= 0n || free < 0n || demand < 0n)
    throw new LedgerError(
      'invalid_quantity',
      'Allocation needs positive requested units and consistent nonnegative stock and demand.',
    );
  const quantity = [wanted, free, demand].reduce((smallest, value) =>
    value < smallest ? value : smallest,
  );

  return {
    allocated: decimalQuantity(quantity),
    unallocated: decimalQuantity(demand - quantity),
  };
}

/** Checks a reservation's retained equation before changing any remaining quantity. */
function requireReservation(value: StockReservation) {
  const allocated = quantityUnits(value.allocated),
    remaining = quantityUnits(value.remaining),
    consumed = quantityUnits(value.consumed),
    released = quantityUnits(value.released);
  if (
    [allocated, remaining, consumed, released].some((units) => units < 0n) ||
    allocated !== remaining + consumed + released ||
    (value.state === 'active') !== remaining > 0n
  )
    throw new LedgerError(
      'invalid_entry',
      'Reservation quantities or lifecycle are inconsistent.',
    );
}

/** Consumes only independently verified remaining units and advances one reservation version. */
export function consumeReservation(
  value: StockReservation,
  quantity: string,
  now: string,
): StockReservation {
  requireReservation(value);
  const units = quantityUnits(quantity),
    remaining = quantityUnits(value.remaining);
  if (value.state !== 'active' || units <= 0n || units > remaining)
    throw new LedgerError(
      'insufficient_stock',
      'Verified shipment exceeds this reservation’s remaining units.',
    );
  const next = {
    ...value,
    version: nextStockVersion(value.version),
    remaining: decimalQuantity(remaining - units),
    consumed: decimalQuantity(quantityUnits(value.consumed) + units),
    state: units === remaining ? ('consumed' as const) : ('active' as const),
    updatedAt: now,
  };
  requireReservation(next);

  return next;
}

/** Releases a bounded remaining quantity once; expiry requires its recorded deadline to have elapsed. */
export function releaseReservation(
  value: StockReservation,
  quantity: string,
  reason: 'release' | 'cancel' | 'amend' | 'expiry',
  now: string,
): StockReservation {
  requireReservation(value);
  const units = quantityUnits(quantity),
    remaining = quantityUnits(value.remaining);
  if (value.state !== 'active' || units <= 0n || units > remaining)
    throw new LedgerError(
      'stale',
      'Only an active reservation’s remaining units can be released.',
    );
  if (
    reason === 'expiry' &&
    (!value.expiresAt ||
      !Number.isFinite(Date.parse(value.expiresAt)) ||
      !Number.isFinite(Date.parse(now)) ||
      Date.parse(value.expiresAt) > Date.parse(now))
  )
    throw new LedgerError('stale', 'This reservation has not expired.');
  const next = {
    ...value,
    version: nextStockVersion(value.version),
    remaining: decimalQuantity(remaining - units),
    released: decimalQuantity(quantityUnits(value.released) + units),
    state:
      units === remaining
        ? reason === 'expiry'
          ? ('expired' as const)
          : ('released' as const)
        : ('active' as const),
    updatedAt: now,
  };
  requireReservation(next);

  return next;
}
