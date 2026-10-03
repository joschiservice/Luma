/** One term of Shopify's search syntax, such as `updated_at:>='2026-01-01'` or `"Anna"`. */
export interface SearchTerm {
  field: string | null;
  comparator: '>=' | '<=' | '>' | '<' | '=';
  value: string;
}

/** Store filters and a residual predicate derived from search terms. */
export interface SearchFilter {
  key?: string | undefined;
  updatedFrom?: number | undefined;
  updatedBefore?: number | undefined;
  createdFrom?: number | undefined;
  createdBefore?: number | undefined;
  /** Text terms the store cannot index, matched against record text. */
  text: string[];
}

const comparators = ['>=', '<=', '>', '<', '='] as const;

const term =
  /(?:([a-z_]+):)?(>=|<=|>|<|=)?("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s"']+)/gy;

/** Removes quotes and escapes from a search value. */
const unquote = (value: string) =>
  /^(["']).*\1$/s.test(value)
    ? value.slice(1, -1).replace(/\\(.)/g, '$1')
    : value;

/**
 * Parses Shopify's search syntax into terms. Connectives are treated as AND, as Luma's
 * searches only combine terms that must all match.
 */
export function parseSearch(query: string): SearchTerm[] {
  const terms: SearchTerm[] = [];
  let position = 0;
  while (position < query.length) {
    if (/\s/.test(query[position] ?? '')) {
      position += 1;
      continue;
    }
    term.lastIndex = position;
    const match = term.exec(query);
    if (!match) {
      position += 1;
      continue;
    }
    position = term.lastIndex;
    const value = unquote(match[3] ?? '');
    if (!match[1] && ['AND', 'OR'].includes(value)) continue;
    terms.push({
      field: match[1] ?? null,
      comparator: comparators.find((value) => value === match[2]) ?? '=',
      value,
    });
  }

  return terms;
}

/** Applies a time comparison to inclusive-from and exclusive-before bounds. */
function bound(
  filter: SearchFilter,
  prefix: 'updated' | 'created',
  { comparator, value }: SearchTerm,
) {
  const time = Date.parse(value);
  if (Number.isNaN(time)) return;
  const from = `${prefix}From` as const;
  const before = `${prefix}Before` as const;
  if (comparator === '>=' || comparator === '=')
    filter[from] = Math.max(filter[from] ?? time, time);
  if (comparator === '>')
    filter[from] = Math.max(filter[from] ?? time + 1, time + 1);
  if (comparator === '<')
    filter[before] = Math.min(filter[before] ?? time, time);
  if (comparator === '<=' || comparator === '=')
    filter[before] = Math.min(filter[before] ?? time + 1000, time + 1000);
}

/**
 * Builds store filters from a search. `keyField` names the field the store indexes as the
 * record key, such as `email` for customers; `normalize` prepares its value. Unknown fields are
 * ignored, as Shopify ignores unsupported filters.
 */
export function searchFilter(
  query: string | null | undefined,
  keyField?: string,
  normalize: (value: string) => string = (value) => value,
): SearchFilter {
  const filter: SearchFilter = { text: [] };
  for (const item of parseSearch(query ?? '')) {
    if (item.field === 'updated_at') bound(filter, 'updated', item);
    else if (item.field === 'created_at' || item.field === 'processed_at')
      bound(filter, 'created', item);
    else if (keyField && item.field === keyField)
      filter.key = normalize(item.value);
    else if (!item.field) filter.text.push(item.value.toLowerCase());
  }

  return filter;
}

/** Whether every text term occurs in one of the given values, ignoring case. */
export const matchesText = (text: string[], values: (string | null)[]) =>
  text.every((part) =>
    values.some((value) => value?.toLowerCase().includes(part)),
  );
