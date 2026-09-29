/**
 * A readable fallback label for a SKU or location without a code or title. Imported records
 * use a source-local reconciliation key; show the trailing part of the source ID instead.
 */
export function readableKey(
  kind: 'sku' | 'location',
  key: string,
  connectionLabel?: string,
) {
  let externalId: unknown;
  try {
    const parsed: unknown = JSON.parse(key);
    if (Array.isArray(parsed) && parsed[0] === 'source') externalId = parsed[4];
  } catch {
    return key;
  }
  if (typeof externalId !== 'string') return key;
  const short = externalId.split('/').at(-1) || externalId;
  const noun = kind === 'sku' ? 'SKU' : 'Location';

  return connectionLabel
    ? `${connectionLabel} ${noun.toLowerCase()} ${short}`
    : `${noun} ${short}`;
}
