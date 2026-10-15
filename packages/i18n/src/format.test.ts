import { afterEach, describe, expect, it } from 'vitest';

import { overwriteGetLocale } from '../dist/paraglide/runtime.js';
import {
  formatCalendarDate,
  formatCurrency,
  formatDateTime,
  formatExactQuantity,
  formatList,
  formatNumber,
  formatRelativeTime,
  parseExactQuantityInput,
} from './format';

afterEach(() => overwriteGetLocale(() => 'en'));

describe('formatting', () => {
  it('parses local decimal quantities exactly and refuses grouping and excess precision', () => {
    expect(parseExactQuantityInput('999999999999999999.123456')).toBe(
      '999999999999999999.123456',
    );
    expect(parseExactQuantityInput('1,234')).toBeNull();
    expect(parseExactQuantityInput('1.1234567')).toBeNull();
    overwriteGetLocale(() => 'de');
    expect(parseExactQuantityInput('3,125001')).toBe('3.125001');
    expect(parseExactQuantityInput('1.234')).toBeNull();
  });
  it('retains exact stock quantities beyond floating point precision in both languages', () => {
    expect(formatExactQuantity('999999999999999999.123456')).toBe(
      '999,999,999,999,999,999.123456',
    );
    expect(formatExactQuantity('2.000000')).toBe('2');
    expect(formatExactQuantity('2.125000')).toBe('2.125');
    expect(formatExactQuantity('-0.125001')).toBe('-0.125001');
    overwriteGetLocale(() => 'de');
    expect(formatExactQuantity('999999999999999999.123456')).toBe(
      '999.999.999.999.999.999,123456',
    );
  });
  it('follows the active language', () => {
    expect(formatNumber(12345.5)).toBe('12,345.5');
    expect(formatCalendarDate('2026-10-08', { dateStyle: 'long' })).toBe(
      '8 October 2026',
    );

    overwriteGetLocale(() => 'de');
    expect(formatNumber(12345.5)).toBe('12.345,5');
    expect(formatCurrency(12.5, 'EUR')).toBe('12,50\u00a0€');
    expect(formatCalendarDate('2026-10-08', { dateStyle: 'long' })).toBe(
      '8. Oktober 2026',
    );
    expect(formatList(['Shopify', 'JTL', 'Amazon'])).toBe(
      'Shopify, JTL und Amazon',
    );
  });

  it('uses a 24-hour clock in the requested time zone', () => {
    expect(
      formatDateTime('2026-10-08T12:05:00Z', {
        timeStyle: 'short',
        timeZone: 'Europe/Berlin',
      }),
    ).toBe('14:05');
  });

  it('describes relative time in whole units', () => {
    const now = '2026-10-08T12:00:00Z';
    expect(formatRelativeTime('2026-10-08T11:55:00Z', now)).toBe(
      '5 minutes ago',
    );
    expect(formatRelativeTime('2026-10-10T12:00:00Z', now)).toBe('in 2 days');
    expect(formatRelativeTime(now, now)).toBe('now');
  });
});
