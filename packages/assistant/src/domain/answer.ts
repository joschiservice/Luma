export type RecordKind =
  | 'order'
  | 'issue'
  | 'stock_position'
  | 'fulfillment'
  | 'return'
  | 'customer'
  | 'purchase_order';

/** A record a read returned, with the source and observation time of that read. */
export interface RecordReference {
  kind: RecordKind;
  id: string;
  label: string;
  detail: string | null;
  sources: { label: string; system: string | null }[];
  observedAt: string | null;
  sourceUpdatedAt: string | null;
}

const kinds =
  'order|issue|stock_position|fulfillment|return|customer|purchase_order';
const uuid = '[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}';
const markers = new RegExp(`\\[\\[(${kinds}):(${uuid})\\]\\]`, 'g');

/** The marker a read puts next to each record and the model copies into its answer. */
export function citationMarker(kind: RecordKind, id: string) {
  return `[[${kind}:${id.toLowerCase()}]]`;
}

/**
 * Keeps citation markers for records read while answering this question and removes the rest,
 * so an answer can't link to a record it did not read. Returns the cited records in order of
 * first mention.
 */
export function resolveCitations(
  text: string,
  read: ReadonlyMap<string, RecordReference>,
): { content: string; citations: RecordReference[] } {
  const cited = new Map<string, RecordReference>();
  const content = text
    .replace(markers, (_marker: string, kind: string, id: string) => {
      const key = citationMarker(kind as RecordKind, id);
      const record = read.get(key);
      if (!record) return '';
      cited.set(key, record);

      return key;
    })
    // Removing a marker can leave a space before punctuation or a doubled space.
    .replace(/[ \t]+([.,;:!?)])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

  return { content, citations: [...cited.values()] };
}

/** Shortens provider text before it reaches the model. */
export function clip(value: string | null | undefined, length = 200) {
  if (value == null) return null;
  const text = value.replace(/\s+/g, ' ').trim();

  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

/**
 * Serializes a read result for the model within `maxLength` characters. Strings are clipped,
 * and items are removed from the end of the top-level `items` list until the result fits;
 * `omitted` reports how many were removed. A result that still doesn't fit is replaced by a
 * notice, so nothing is cut mid-record.
 */
export function boundResult(value: unknown, maxLength: number): string {
  const clipped = clipStrings(value);
  const text = JSON.stringify(clipped);
  if (text.length <= maxLength) return text;
  if (
    clipped &&
    typeof clipped === 'object' &&
    !Array.isArray(clipped) &&
    Array.isArray(clipped.items)
  ) {
    const items = [...clipped.items];
    while (items.length) {
      items.pop();
      const shorter = JSON.stringify({
        ...clipped,
        items,
        omitted: clipped.items.length - items.length,
        omittedNote:
          'Omitted items were read but not shown, and nextCursor continues after them. Use narrower filters to see them.',
      });
      if (shorter.length <= maxLength) return shorter;
    }
  }

  return JSON.stringify({
    error: 'result_too_large',
    message: 'This read returned too much to show. Use narrower filters.',
  });
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Copies a value as JSON with long strings clipped. Undefined fields are dropped, as in JSON. */
function clipStrings(value: unknown): Json {
  if (typeof value === 'string') return clip(value, 500);
  if (Array.isArray(value))
    return value.map((item) => clipStrings(item ?? null));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, item]) =>
        item === undefined ? [] : [[key, clipStrings(item)]],
      ),
    );
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;

  return null;
}

/** Contextual narratives must cite every paragraph/list item and may reference only current-question reads. */
export function groundedContextualAnswer(
  text: string,
  read: ReadonlyMap<string, RecordReference>,
): boolean {
  const withoutValidMarkers = text.replace(markers, '');
  if (withoutValidMarkers.includes('[[') || withoutValidMarkers.includes(']]'))
    return false;
  const references = text.match(/\[\[[^\]\n]+\]\]/g) ?? [];
  if (references.some((marker) => !read.has(marker))) return false;
  const paragraphs = text
    .split(/\n\s*\n/)
    .flatMap((paragraph) => {
      const lines = paragraph.split('\n').filter((line) => line.trim());

      return lines.some((line) => /^\s*(?:[-*•]|\d+[.)])\s/.test(line))
        ? lines
        : [paragraph];
    })
    .filter((paragraph) => paragraph.trim());

  return (
    paragraphs.length > 0 &&
    paragraphs.every((paragraph) =>
      [...read.keys()].some((marker) => paragraph.includes(marker)),
    )
  );
}
