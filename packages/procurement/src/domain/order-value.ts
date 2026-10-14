import type { PurchaseOrder } from './procurement.js';

/** An exact decimal: `units` × 10^-`scale`. */
export interface Decimal {
  units: bigint;
  scale: number;
}

/** An exact amount in one ISO currency. */
export interface Amount {
  amount: string;
  currency: string;
}

/**
 * Parses a finite decimal such as `12.50`, `-3` or `1e-7` (the form JavaScript prints small
 * numbers in). Returns null for anything else.
 */
export function parseDecimal(text: string): Decimal | null {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(text);
  if (!match) return null;
  const [, sign = '', whole = '', fraction = '', exponent = '0'] = match;
  const shift = Number(exponent);
  if (!Number.isSafeInteger(shift) || Math.abs(shift) > 100) return null;
  let units = BigInt(`${whole}${fraction}`);
  let scale = fraction.length - shift;
  if (scale < 0) {
    units *= 10n ** BigInt(-scale);
    scale = 0;
  }

  return { units: sign ? -units : units, scale };
}

function aligned(a: Decimal, b: Decimal): [bigint, bigint, number] {
  const scale = Math.max(a.scale, b.scale);

  return [
    a.units * 10n ** BigInt(scale - a.scale),
    b.units * 10n ** BigInt(scale - b.scale),
    scale,
  ];
}

/** Compares two decimals numerically: negative, zero or positive. */
export function compareDecimals(a: Decimal, b: Decimal): number {
  const [x, y] = aligned(a, b);

  return x < y ? -1 : x > y ? 1 : 0;
}

/** Adds two decimals exactly. */
export function addDecimals(a: Decimal, b: Decimal): Decimal {
  const [x, y, scale] = aligned(a, b);

  return { units: x + y, scale };
}

/** Formats a decimal without trailing fractional zeros, such as `12.5` or `-3`. */
export function formatDecimal({ units, scale }: Decimal): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units)
    .toString()
    .padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale).replace(/0+$/, '');

  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/**
 * The order's value: the exact sum of quantity × unit price over its lines. Null when no line
 * has a price; `unknown` when only some lines have one or prices use different currencies,
 * because Luma cannot know the total then.
 */
export function orderValue(
  order: Pick<PurchaseOrder, 'lines'>,
): Amount | null | 'unknown' {
  const priced = order.lines.filter((line) => line.unitPrice);
  if (!priced.length) return null;
  const currency = priced[0]!.unitPrice!.currency;
  if (
    priced.length !== order.lines.length ||
    priced.some((line) => line.unitPrice!.currency !== currency)
  )
    return 'unknown';
  let total: Decimal = { units: 0n, scale: 0 };
  for (const line of priced) {
    const price = parseDecimal(line.unitPrice!.amount);
    const quantity = parseDecimal(String(line.quantity));
    if (!price || !quantity) return 'unknown';
    total = addDecimals(total, {
      units: price.units * quantity.units,
      scale: price.scale + quantity.scale,
    });
  }

  return { amount: formatDecimal(total), currency };
}
