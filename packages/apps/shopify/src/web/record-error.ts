import { m } from '@luma/i18n/messages';
import { z } from 'zod';

/** Presents record-read failures without exposing provider messages or suggesting credential entry. */
export function recordError(
  error: unknown,
  fallback: (error: unknown) => string,
): string {
  const result = z.object({ status: z.number() }).safeParse(error);
  if (result.success) {
    if (result.data.status === 404) return m.shopify_record_error_not_found();
    if (result.data.status === 403) return m.shopify_record_error_forbidden();
    if (result.data.status === 422) return m.shopify_record_error_invalid();
  }

  return fallback(error);
}
