import type { Locale } from '../dist/paraglide/runtime.js';

export type { Locale };

/** Each language's own name, so people can find their language whatever the current one is. */
export const localeNames: Record<Locale, string> = {
  en: 'English',
  de: 'Deutsch',
};

/**
 * Formatting conventions for each interface language. English uses day-month-year dates and a
 * 24-hour clock, as in “8 October 2026, 14:05”, while keeping US spelling in the messages.
 */
export const formattingLocales: Record<Locale, string> = {
  en: 'en-GB',
  de: 'de-DE',
};
