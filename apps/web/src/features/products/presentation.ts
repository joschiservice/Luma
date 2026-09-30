import type {
  CatalogField,
  CatalogItem,
  CatalogListing,
  CatalogSource,
  CatalogView,
} from '@luma/api-contract';
import type { OperationalState } from '@luma/ui/components/primitives/state';

import { ago } from '../sync/presentation';

export const statusLabels: Record<CatalogListing['status'], string> = {
  active: 'Active',
  draft: 'Draft',
  archived: 'Archived',
  unknown: 'Status unknown',
};

export const fieldLabels: Record<CatalogField, string> = {
  title: 'Title',
  status: 'Status',
  published: 'Sales channel',
  price: 'Price',
  barcode: 'Barcode',
};

export const viewLabels: Record<CatalogView, string> = {
  all: 'All SKUs',
  differs: 'Differs by source',
  missing: 'Not in every source',
  unlinked: 'Possible matches',
};

export const viewDescriptions: Record<CatalogView, string> = {
  all: 'Every SKU in a connected catalog, one row per SKU with each source side by side.',
  differs:
    'SKUs whose sources disagree on title, status, sales channel, price or barcode.',
  missing:
    'SKUs that at least one catalog source does not list. Some items are intentionally sold or managed in one system only.',
  unlinked:
    'SKUs with a same-code SKU in another source that is not linked yet. Link them if they are the same item.',
};

/** Names the kind of system behind a connection, for example "Shopify" or "JTL-Wawi". */
export function systemName(system: string | null) {
  if (system === 'shopify') return 'Shopify';
  if (system?.startsWith('jtl')) return 'JTL-Wawi';

  return 'Connected source';
}

/** Describes a source's own sales channel listing in that system's terms. */
export function listingLabel(published: boolean | null, system: string | null) {
  if (published === null) return 'Not reported';
  if (system === 'shopify')
    return published ? 'Published to Online Store' : 'Not on Online Store';
  if (system?.startsWith('jtl'))
    return published ? 'Active for shops' : 'Not active for shops';

  return published ? 'Listed for sale' : 'Not listed for sale';
}

/**
 * Formats a list price without converting it. A price without a reported currency shows its
 * amount and says so, because it cannot be compared with priced sources.
 */
export function formatPrice(price: CatalogListing['price'], locale?: string) {
  if (!price) return null;
  const amount = Number(price.amount);
  if (!price.currency) return `${price.amount} (currency not reported)`;
  if (!Number.isFinite(amount)) return `${price.amount} ${price.currency}`;
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: price.currency,
    }).format(amount);
  } catch {
    return `${price.amount} ${price.currency}`;
  }
}

/** Joins a product title and variant title as each source names the SKU. */
export function listingTitle(listing: CatalogListing) {
  return (
    [listing.productTitle, listing.variantTitle].filter(Boolean).join(' · ') ||
    'Untitled'
  );
}

/** Labels how long ago Luma read a listing; source update time is shown separately. */
export function readAge(observedAt: string, asOf: string) {
  const age = Date.parse(asOf) - Date.parse(observedAt);
  if (age < 0) return 'Read time is ahead';

  return `Read ${ago(observedAt, Date.parse(asOf))}`;
}

/** Summarizes one SKU's catalog state as a labelled operational state. */
export function catalogState(
  item: CatalogItem,
  sources: CatalogSource[],
): { state: OperationalState; label: string } {
  if (item.differences.length)
    return { state: 'attention', label: 'Differs by source' };
  if (item.gaps.some((gap) => gap.match))
    return { state: 'waiting', label: 'Possible match to link' };
  if (!item.listings.length)
    return { state: 'idle', label: 'Not in any catalog' };
  if (item.gaps.length)
    return { state: 'waiting', label: 'Not in every source' };
  const count = new Set(item.listings.map((l) => l.connectionId)).size;
  if (count === 1 || sources.length < 2)
    return { state: 'idle', label: 'One source' };

  return { state: 'idle', label: `Listed in all ${count} sources` };
}

/** Explains a catalog gap, separating a confirmed absence from an incomplete catalog read. */
export function gapText(
  gap: CatalogItem['gaps'][number],
  source: CatalogSource | undefined,
  asOf: string,
) {
  const label = source?.label ?? 'This source';
  if (gap.match)
    return `${label} has a SKU with the same code (${gap.match.sku.trim()}) that is not linked to this one.`;
  if (!source?.fullReadAt)
    return `${label} does not list this SKU in what Luma has read so far. Its full catalog has not been read yet.`;

  return `${label} does not list this SKU. Its full catalog was read ${ago(source.fullReadAt, Date.parse(asOf))}.`;
}

/** Explains which fields differ in one sentence. */
export function differenceSentence(fields: CatalogField[]) {
  const names = fields.map((field) => fieldLabels[field].toLowerCase());
  if (!names.length) return null;
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

  return `Sources disagree on ${list}.`;
}
