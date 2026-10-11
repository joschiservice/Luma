import type {
  CatalogField,
  CatalogItem,
  CatalogListing,
  CatalogSource,
  CatalogView,
} from '@luma/api-contract';
import { formatList, formatRelativeTime } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import type { OperationalState } from '@luma/ui/components/primitives/state';

import { formatMoney, localizedLabels } from '../../shared/orders/presentation';

export const statusLabels: Record<CatalogListing['status'], string> =
  localizedLabels({
    active: m.products_status_active,
    draft: m.products_status_draft,
    archived: m.products_status_archived,
    unknown: m.products_status_unknown,
  });

export const fieldLabels: Record<CatalogField, string> = localizedLabels({
  title: m.products_field_title,
  status: m.products_field_status,
  published: m.products_field_published,
  price: m.products_field_price,
  barcode: m.products_field_barcode,
});

/** Field names as they read inside a sentence, which differs from labels in some languages. */
const fieldNames: Record<CatalogField, () => string> = {
  title: m.products_field_title_in_sentence,
  status: m.products_field_status_in_sentence,
  published: m.products_field_published_in_sentence,
  price: m.products_field_price_in_sentence,
  barcode: m.products_field_barcode_in_sentence,
};

export const viewLabels: Record<CatalogView, string> = localizedLabels({
  all: m.products_view_all,
  differs: m.products_view_differs,
  missing: m.products_view_missing,
  unlinked: m.products_view_unlinked,
});

export const viewDescriptions: Record<CatalogView, string> = localizedLabels({
  all: m.products_view_all_description,
  differs: m.products_view_differs_description,
  missing: m.products_view_missing_description,
  unlinked: m.products_view_unlinked_description,
});

/** Names the kind of system behind a connection, for example "Shopify" or "JTL-Wawi". */
export function systemName(system: string | null) {
  if (system === 'shopify') return 'Shopify';
  if (system?.startsWith('jtl')) return 'JTL-Wawi';
  if (system?.startsWith('cin7')) return 'Cin7 Core';

  return m.products_system_fallback();
}

/** Describes a source's own sales channel listing in that system's terms. */
export function listingLabel(published: boolean | null, system: string | null) {
  if (published === null) return m.common_not_reported();
  if (system === 'shopify')
    return published
      ? m.products_listing_shopify_published()
      : m.products_listing_shopify_unpublished();
  if (system?.startsWith('jtl'))
    return published
      ? m.products_listing_jtl_published()
      : m.products_listing_jtl_unpublished();

  return published
    ? m.products_listing_published()
    : m.products_listing_unpublished();
}

/**
 * Formats a list price without converting it. A price without a reported currency shows its
 * amount and says so, because it cannot be compared with priced sources.
 */
export function formatPrice(price: CatalogListing['price'], locale?: string) {
  if (!price) return null;
  if (!price.currency)
    return m.products_price_no_currency({ amount: price.amount });

  return formatMoney(
    { amount: price.amount, currency: price.currency },
    locale,
  );
}

/** Joins a product title and variant title as each source names the SKU. */
export function listingTitle(listing: CatalogListing) {
  return (
    [listing.productTitle, listing.variantTitle].filter(Boolean).join(' · ') ||
    m.products_listing_untitled()
  );
}

/** Labels how long ago Luma read a listing; source update time is shown separately. */
export function readAge(observedAt: string, asOf: string) {
  const age = Date.parse(asOf) - Date.parse(observedAt);
  if (age < 0) return m.products_read_time_unclear();

  return m.products_read_ago({ time: formatRelativeTime(observedAt, asOf) });
}

/** Summarizes one SKU's catalog state as a labelled operational state. */
export function catalogState(
  item: CatalogItem,
  sources: CatalogSource[],
): { state: OperationalState; label: string } {
  if (item.differences.length)
    return { state: 'attention', label: m.products_state_differs() };
  if (item.gaps.some((gap) => gap.match))
    return { state: 'waiting', label: m.products_state_possible_match() };
  if (!item.listings.length)
    return { state: 'idle', label: m.products_state_no_catalog() };
  if (item.gaps.length)
    return { state: 'waiting', label: m.products_state_missing() };
  const count = new Set(item.listings.map((l) => l.connectionId)).size;
  if (count === 1 || sources.length < 2)
    return { state: 'idle', label: m.products_state_one_source() };

  return { state: 'idle', label: m.products_state_all_sources({ count }) };
}

/** Explains a catalog gap, separating a confirmed absence from an incomplete catalog read. */
export function gapText(
  gap: CatalogItem['gaps'][number],
  source: CatalogSource | undefined,
  asOf: string,
) {
  const label = source?.label ?? m.products_source_unknown();
  if (gap.match)
    return m.products_gap_match({ source: label, code: gap.match.sku.trim() });
  if (!source?.fullReadAt) return m.products_gap_unread({ source: label });

  return m.products_gap_absent({
    source: label,
    time: formatRelativeTime(source.fullReadAt, asOf),
  });
}

/** Explains which fields differ in one sentence, or null when none do. */
export function differenceSentence(fields: CatalogField[]) {
  if (!fields.length) return null;

  return m.products_difference_sentence({
    fields: formatList(fields.map((field) => fieldNames[field]())),
  });
}
