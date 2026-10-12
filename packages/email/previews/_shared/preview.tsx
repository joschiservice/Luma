import type { Locale } from '@luma/i18n/locales';

import { emailContent } from '../../src/emails.js';
import { samples } from './samples.js';

/** Renders one sample email for the React Email preview server. */
export function EmailPreview(props: {
  kind: keyof typeof samples;
  locale: Locale;
}) {
  return emailContent(samples[props.kind], props.locale).document;
}
