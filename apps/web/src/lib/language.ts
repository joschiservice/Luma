import { useEffect } from 'react';

import { createWebApiClient } from './api-client';

const api = createWebApiClient();

/**
 * Stores the language picked in this browser on the signed-in account, so email Luma sends
 * later uses it. Changing the language sets the `luma_locale` cookie and reloads the page, so
 * the first signed-in page after a change sends it once; this browser remembers what it sent
 * for each account. Support views and browsers without a picked language send nothing. A failed
 * request is retried on a later page load.
 */
export function useLanguageSync(userId: string | undefined, readOnly: boolean) {
  useEffect(() => {
    const language = document.cookie.match(
      /(?:^|;\s*)luma_locale=(en|de)(?:;|$)/,
    )?.[1];
    if (!userId || readOnly || (language !== 'en' && language !== 'de')) return;
    const key = `luma-language:${userId}`;
    try {
      if (localStorage.getItem(key) === language) return;
    } catch {
      return;
    }
    void api.identity.setLanguage({ body: { language } }).then(
      () => {
        try {
          localStorage.setItem(key, language);
        } catch {
          // Without storage, the next page load sends it again.
        }
      },
      () => undefined,
    );
  }, [userId, readOnly]);
}
