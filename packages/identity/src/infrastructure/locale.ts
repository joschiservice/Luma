import type { Locale } from '@luma/i18n/locales';

/**
 * Reads the interface language of a request: the `luma_locale` cookie the web app stores when
 * the person picks a language, else the browser's preferred language. `chosen` tells whether
 * the person picked it. It decides wording only and is never an authority input.
 */
export function requestLocale(headers: Headers | undefined): {
  locale: Locale;
  chosen: boolean;
} {
  const cookie = headers
    ?.get('cookie')
    ?.match(/(?:^|;\s*)luma_locale=(en|de)(?:;|$)/)?.[1];
  if (cookie === 'en' || cookie === 'de')
    return { locale: cookie, chosen: true };

  return {
    locale: headers?.get('accept-language')?.toLowerCase().startsWith('de')
      ? 'de'
      : 'en',
    chosen: false,
  };
}
