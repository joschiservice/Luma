import { afterEach, describe, expect, it } from 'vitest';

import { overwriteGetLocale } from '../dist/paraglide/runtime.js';
import {
  formatCalendarDate,
  formatCurrency,
  formatDateTime,
  formatList,
  formatNumber,
  formatRelativeTime,
} from './format';

afterEach(() => overwriteGetLocale(() => 'en'));

describe('formatting', () => {
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
