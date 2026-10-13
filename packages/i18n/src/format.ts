import { getLocale } from '../dist/paraglide/runtime.js';
import { formattingLocales } from './locales';

type DateInput = Date | string | number;

const numberFormats = new Map<string, Intl.NumberFormat>();
const dateFormats = new Map<string, Intl.DateTimeFormat>();
const relativeFormats = new Map<string, Intl.RelativeTimeFormat>();
const listFormats = new Map<string, Intl.ListFormat>();

function cached<T>(
  cache: Map<string, T>,
  options: object | undefined,
  create: (locale: string) => T,
) {
  const locale = formattingLocales[getLocale()];
  const key = `${locale}|${JSON.stringify(options ?? {})}`;
  let format = cache.get(key);
  if (!format) {
    format = create(locale);
    cache.set(key, format);
  }

  return format;
}

const toDate = (value: DateInput) =>
  value instanceof Date ? value : new Date(value);

/** Returns the BCP 47 locale used for numbers, dates and lists in the active interface language. */
export function formattingLocale() {
  return formattingLocales[getLocale()];
}

/** Formats a number with the active language's digit grouping and decimal separator. */
export function formatNumber(
  value: number,
  options?: Intl.NumberFormatOptions,
) {
  return cached(
    numberFormats,
    options,
    (locale) => new Intl.NumberFormat(locale, options),
  ).format(value);
}

/** Formats an exact decimal string without converting its magnitude to floating point. */
export function formatExactQuantity(value: string) {
  if (!/^-?\d+(?:\.\d+)?$/.test(value))
    throw new RangeError('Expected a decimal quantity');
  const [whole, fraction] = value.split('.');
  const formatter = cached(
    numberFormats,
    { maximumFractionDigits: 0 },
    (locale) => new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }),
  );
  const grouped = formatter.format(BigInt(whole!));
  const decimal = new Intl.NumberFormat(formattingLocale())
    .formatToParts(1.1)
    .find((part) => part.type === 'decimal')!.value;
  const negativeZero = value.startsWith('-') && BigInt(whole!) === 0n;

  return `${negativeZero ? '-' : ''}${grouped}${fraction ? `${decimal}${fraction}` : ''}`;
}

/** Parses an ungrouped quantity using the active decimal separator; invalid or excessive precision returns null. */
export function parseExactQuantityInput(value: string): string | null {
  const decimal = new Intl.NumberFormat(formattingLocale())
    .formatToParts(1.1)
    .find((part) => part.type === 'decimal')!.value;
  const trimmed = value.trim();
  if (decimal !== '.' && trimmed.includes('.')) return null;
  const canonical = trimmed.split(decimal).join('.');

  return /^-?\d{1,18}(?:\.\d{1,6})?$/.test(canonical) ? canonical : null;
}

/** Formats a ratio such as 0.25 as a percentage in the active language. */
export function formatPercent(
  ratio: number,
  options?: Omit<Intl.NumberFormatOptions, 'style'>,
) {
  return formatNumber(ratio, {
    maximumFractionDigits: 0,
    ...options,
    style: 'percent',
  });
}

/** Formats an amount in an ISO 4217 currency, such as EUR, in the active language. */
export function formatCurrency(
  amount: number,
  currency: string,
  options?: Omit<Intl.NumberFormatOptions, 'style' | 'currency'>,
) {
  return formatNumber(amount, { ...options, style: 'currency', currency });
}

/**
 * Formats a date and time with the given options. Without options it shows a medium date and a
 * short time, such as “8 Oct 2026, 14:05”. Pass `timeZone` to show workspace time. Times use a
 * 24-hour clock in every interface language unless `hourCycle` or `hour12` says otherwise.
 */
export function formatDateTime(
  value: DateInput,
  options: Intl.DateTimeFormatOptions = {
    dateStyle: 'medium',
    timeStyle: 'short',
  },
) {
  const resolved: Intl.DateTimeFormatOptions =
    options.hour12 === undefined ? { hourCycle: 'h23', ...options } : options;

  return cached(
    dateFormats,
    resolved,
    (locale) => new Intl.DateTimeFormat(locale, resolved),
  ).format(toDate(value));
}

/** Formats a calendar date, such as “8 Oct 2026”, in the active language. */
export function formatDate(
  value: DateInput,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' },
) {
  return formatDateTime(value, options);
}

/** Formats a time of day, such as “14:05”, in the active language. */
export function formatTime(
  value: DateInput,
  options: Intl.DateTimeFormatOptions = { timeStyle: 'short' },
) {
  return formatDateTime(value, options);
}

/**
 * Formats an ISO calendar date such as `2026-10-08` without shifting it into the viewer's time
 * zone.
 */
export function formatCalendarDate(
  value: string,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' },
) {
  return formatDateTime(new Date(`${value}T00:00:00Z`), {
    ...options,
    timeZone: 'UTC',
  });
}

const relativeUnits: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 60 * 60],
  ['month', 30 * 24 * 60 * 60],
  ['week', 7 * 24 * 60 * 60],
  ['day', 24 * 60 * 60],
  ['hour', 60 * 60],
  ['minute', 60],
  ['second', 1],
];

/**
 * Describes how long ago or how far ahead a moment is, such as “5 minutes ago” or “in 2 days”,
 * using the largest whole unit.
 */
export function formatRelativeTime(
  value: DateInput,
  now: DateInput = Date.now(),
  options: Intl.RelativeTimeFormatOptions = { numeric: 'auto' },
) {
  const seconds = (toDate(value).getTime() - toDate(now).getTime()) / 1000;
  const [unit, size] =
    relativeUnits.find(([, size]) => Math.abs(seconds) >= size) ??
    relativeUnits[relativeUnits.length - 1]!;

  return cached(
    relativeFormats,
    options,
    (locale) => new Intl.RelativeTimeFormat(locale, options),
  ).format(Math.trunc(seconds / size), unit);
}

/** Joins items into a list such as “Shopify, JTL and Amazon” in the active language. */
export function formatList(
  items: readonly string[],
  options: Intl.ListFormatOptions = { type: 'conjunction' },
) {
  return cached(
    listFormats,
    options,
    (locale) => new Intl.ListFormat(locale, options),
  ).format(items);
}
