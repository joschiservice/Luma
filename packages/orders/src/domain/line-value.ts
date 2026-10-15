import { fromUnits, toUnits } from './returns.js';

interface Money {
  amount: string;
  currency: string;
}

const scale = 1_000_000n;

/**
 * The value of a line's units at one unit price: units × price, computed exactly from canonical
 * decimals and rounded half away from zero to millionths of the currency unit. Null when either
 * the price or the units are unknown, so a missing fact never reads as zero.
 */
export function lineValue(
  unitPrice: Money | null | undefined,
  units: string | null,
): Money | null {
  if (!unitPrice || units === null) return null;
  const product = toUnits(unitPrice.amount) * toUnits(units);
  const negative = product < 0n;
  const rounded = ((negative ? -product : product) + scale / 2n) / scale;

  return {
    amount: fromUnits(negative ? -rounded : rounded),
    currency: unitPrice.currency,
  };
}
