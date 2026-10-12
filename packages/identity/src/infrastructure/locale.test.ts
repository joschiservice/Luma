import { expect, it } from 'vitest';

import { requestLocale } from './locale.js';

it('prefers the language picked in Luma over the browser preference', () => {
  expect(
    requestLocale(
      new Headers({ cookie: 'a=1; luma_locale=de', 'accept-language': 'en' }),
    ),
  ).toEqual({ locale: 'de', chosen: true });
  expect(
    requestLocale(new Headers({ 'accept-language': 'de-AT,de;q=0.9' })),
  ).toEqual({ locale: 'de', chosen: false });
  expect(requestLocale(new Headers({ cookie: 'luma_locale=fr' }))).toEqual({
    locale: 'en',
    chosen: false,
  });
  expect(requestLocale(undefined)).toEqual({ locale: 'en', chosen: false });
});
