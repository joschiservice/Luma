import type {
  CatalogSource,
  CollectionGranularity,
  CollectionGroup,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import type { DisplayColumn } from '@luma/ui/components/primitives/collection-display';

import type {
  CatalogPresentation,
  RuntimeOptions,
} from '../../kit/collections/fields';
import { collectionGroupLabel } from '../../kit/collections/groups';
import { fieldLabels, statusLabels, viewLabels } from './presentation';

const sku = () => m.products_area_sku();
const listing = () => m.products_area_listing();
const comparison = () => m.products_area_comparison();

const option = (labels: Readonly<Record<string, string>>) => (value: string) =>
  labels[value] ?? value;

/** How the Products list names each catalog field and its options. */
export const productsPresentation: CatalogPresentation = {
  sku: { label: m.products_field_sku, group: sku },
  title: { label: m.products_field_title, group: sku },
  updated: {
    label: m.products_field_updated,
    description: m.products_field_updated_description,
    group: sku,
  },
  listings: {
    label: m.products_filter_listed_in,
    description: m.products_field_listings_description,
    group: comparison,
  },
  missing: {
    label: m.products_filter_missing_from,
    description: m.products_field_missing_description,
    group: comparison,
  },
  differences: {
    label: m.products_field_differences,
    description: m.products_field_differences_description,
    group: comparison,
    option: option(fieldLabels),
  },
  status: {
    label: m.products_field_status,
    group: listing,
    option: option(statusLabels),
  },
  published: { label: m.products_field_published, group: listing },
  vendor: { label: m.products_detail_field_vendor, group: listing },
  price: { label: m.products_field_price, group: listing },
  barcode: { label: m.products_field_barcode, group: listing },
  bundle: {
    label: m.products_field_bundle,
    description: m.products_field_bundle_description,
    group: listing,
  },
};

/** Names a built-in Products view. */
export function productSegmentLabel(segment: string) {
  const labels: Readonly<Record<string, string>> = viewLabels;

  return labels[segment] ?? segment;
}

/**
 * Names one group of the Products list: a status or differing field, a vendor as the sources
 * write it, or "No value".
 */
export function productGroupLabel(
  field: string,
  granularity: CollectionGranularity | undefined,
  key: CollectionGroup['key'],
  options: RuntimeOptions = {},
): string {
  return collectionGroupLabel({
    presentation: productsPresentation,
    field,
    granularity,
    key,
    options,
  });
}

const listingPrefix = 'listing';

/**
 * The Display column ID of one source's listings, such as `listing3f2a…`. Column IDs allow only
 * letters and digits, so the connection ID loses its dashes.
 */
export function listingColumn(connectionId: string) {
  return `${listingPrefix}${connectionId.replaceAll('-', '')}`;
}

/** The connection ID behind a per-source listing column, or null for other columns. */
export function listingColumnSource(key: string): string | null {
  const hex = /^listing([0-9a-f]{32})$/.exec(key)?.[1];

  return hex
    ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
    : null;
}

/** One Display column per catalog source, showing how that source lists each SKU. */
export function listingColumns(
  sources: readonly Pick<CatalogSource, 'connectionId' | 'label'>[],
): DisplayColumn[] {
  return sources.map((source) => ({
    key: listingColumn(source.connectionId),
    label: m.products_column_listing({ source: source.label }),
    description: m.products_column_listing_description(),
    group: m.products_area_sources(),
    origin: 'source',
  }));
}
