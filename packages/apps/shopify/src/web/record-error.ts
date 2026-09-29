import { z } from 'zod';

/** Presents record-read failures without exposing provider messages or suggesting credential entry. */
export function recordError(
  error: unknown,
  fallback: (error: unknown) => string,
): string {
  const result = z.object({ status: z.number() }).safeParse(error);
  if (result.success) {
    if (result.data.status === 404)
      return 'This record or connection is unavailable. Older orders may require additional Shopify history access.';
    if (result.data.status === 403)
      return 'This connection does not have access to this record. Check its permissions in Apps & connections.';
    if (result.data.status === 422)
      return 'Choose the matching record type and enter its Shopify ID.';
  }

  return fallback(error);
}
