import type { Locale } from '@luma/i18n/locales';
import { render } from 'react-email';

import { type Email, emailContent } from './emails.js';

/**
 * Renders an email in the recipient's language as a subject, HTML and a plain-text version.
 * The text version keeps every link address once and drops the button fallback and preview
 * text, so it reads as a short letter.
 */
export async function renderEmail(email: Email, locale: Locale) {
  const { subject, document } = emailContent(email, locale);
  const [html, text] = await Promise.all([
    render(document),
    render(document, {
      plainText: true,
      htmlToTextOptions: {
        selectors: [
          { selector: 'h1', options: { uppercase: false } },
          { selector: 'table', format: 'block' },
        ],
      },
    }),
  ]);

  return { subject, html, text: text.trim() };
}
