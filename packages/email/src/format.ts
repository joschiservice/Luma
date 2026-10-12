import { formattingLocales, type Locale } from '@luma/i18n/locales';

/*
 * Emails are rendered outside a web request, so these take the recipient's language explicitly
 * instead of reading the request language like the @luma/i18n helpers.
 */

/** Formats a moment as “8 Oct 2026, 14:05 CEST” in the given language and IANA time zone. */
export function formatEmailDateTime(
  value: Date,
  locale: Locale,
  timeZone: string,
) {
  return new Intl.DateTimeFormat(formattingLocales[locale], {
    dateStyle: 'medium',
    timeStyle: 'short',
    hourCycle: 'h23',
    timeZone,
  })
    .format(value)
    .concat(' ', zoneName(value, locale, timeZone));
}

/** Formats a calendar date as “8 October 2026” in the given language and IANA time zone. */
export function formatEmailDate(value: Date, locale: Locale, timeZone: string) {
  return new Intl.DateTimeFormat(formattingLocales[locale], {
    dateStyle: 'long',
    timeZone,
  }).format(value);
}

function zoneName(value: Date, locale: Locale, timeZone: string) {
  return (
    new Intl.DateTimeFormat(formattingLocales[locale], {
      timeZone,
      timeZoneName: 'short',
    })
      .formatToParts(value)
      .find((part) => part.type === 'timeZoneName')?.value ?? timeZone
  );
}
