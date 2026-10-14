import type {
  CatalogItem,
  CatalogSource,
  ProductList,
} from '@luma/api-contract';
import { formatList } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Badge } from '@luma/ui/components/primitives/badge';
import { StatePill } from '@luma/ui/components/primitives/state';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import type { ReactElement, ReactNode } from 'react';

import { listingColumnSource } from './collection';
import {
  catalogState,
  fieldLabels,
  formatPrice,
  listingLabel,
  listingTitle,
  readAge,
  statusLabels,
} from './presentation';

/** What the fields of one row need from the list: its sources, read time and match links. */
export interface ProductFieldContext {
  sources: ProductList['sources'];
  asOf: string;
  /** Links an unlinked match in a source gap to that SKU's page. */
  matchLink?: ((skuId: string, text: string) => ReactElement) | undefined;
}

/**
 * How the SKU compares across sources, with the fields that differ. Every layout shows these,
 * whatever the Display settings.
 */
export function ProductFlags({
  item,
  sources,
}: {
  item: CatalogItem;
  sources: CatalogSource[];
}) {
  const state = catalogState(item, sources);

  return (
    <span className="products-flags">
      <StatePill state={state.state}>{state.label}</StatePill>
      {item.differences.map((field) => (
        <Badge key={field} tone="warning">
          {fieldLabels[field]}
        </Badge>
      ))}
    </span>
  );
}

/** Shows one source's listing of a SKU, or why the source has none. */
export function ListingCell({
  item,
  source,
  context,
}: {
  item: CatalogItem;
  source: Pick<CatalogSource, 'connectionId' | 'system' | 'fullReadAt'>;
  context: ProductFieldContext;
}) {
  const listings = item.listings.filter(
    (listing) => listing.connectionId === source.connectionId,
  );
  const differs = (field: keyof typeof fieldLabels) =>
    item.differences.includes(field) ? 'products-difference' : undefined;
  const listing = listings[0];
  if (!listing) {
    const gap = item.gaps.find(
      (entry) => entry.connectionId === source.connectionId,
    );
    const match = gap?.match;

    return (
      <div className="products-listing products-listing-gap">
        <span>{m.products_listing_not_in_catalog()}</span>
        {match && context.matchLink ? (
          context.matchLink(
            match.skuId,
            m.products_listing_same_code({ sku: match.sku.trim() }),
          )
        ) : match ? (
          <small>
            {m.products_listing_same_code({ sku: match.sku.trim() })}
          </small>
        ) : (
          <small>
            {source.fullReadAt
              ? m.products_listing_full_read()
              : m.products_listing_full_unread()}
          </small>
        )}
      </div>
    );
  }

  return (
    <div className="products-listing">
      {item.differences.includes('title') ? (
        <span className={differs('title')}>{listingTitle(listing)}</span>
      ) : null}
      <span className={differs('status')}>{statusLabels[listing.status]}</span>
      <span className={differs('price')}>
        {formatPrice(listing.price) ?? m.products_listing_no_price()}
      </span>
      <small className={differs('published')}>
        {listingLabel(listing.published, source.system)}
      </small>
      <small>
        {readAge(listing.observedAt, context.asOf)}
        {listings.length > 1
          ? ` · ${m.products_listing_in_products({ count: listings.length })}`
          : ''}
      </small>
    </div>
  );
}

const empty = () => m.common_empty_value();

/** Joins the distinct values every listing reports, or a dash when none does. */
function distinct(values: readonly (string | null | undefined)[]) {
  const shown = [
    ...new Set(values.filter((value): value is string => !!value)),
  ];

  return shown.length ? formatList(shown) : empty();
}

/** The number of distinct sources that list a SKU. */
function listedSources(item: CatalogItem) {
  return new Set(item.listings.map((listing) => listing.connectionId)).size;
}

/**
 * Renders one Products catalog field of a SKU, for table cells, list properties and the preview.
 * Listing facts join what the sources report, without repeats; a per-source column shows that
 * source's listing.
 */
export function productField(
  item: CatalogItem,
  key: string,
  context: ProductFieldContext,
): ReactNode {
  const source = listingColumnSource(key);
  if (source) {
    const known = context.sources.find(
      (entry) => entry.connectionId === source,
    );

    return (
      <ListingCell
        item={item}
        source={
          known ?? { connectionId: source, system: null, fullReadAt: null }
        }
        context={context}
      />
    );
  }
  switch (key) {
    case 'sku':
      return item.sku.trim();
    case 'title':
      return item.title ?? m.products_no_title();
    case 'listings':
      return m.products_listed_in({
        count: listedSources(item),
        total: context.sources.length,
      });
    case 'differences':
      return item.differences.length
        ? formatList(item.differences.map((field) => fieldLabels[field]))
        : empty();
    case 'missing':
      return item.gaps.length
        ? formatList(
            item.gaps.map(
              (gap) =>
                context.sources.find(
                  (entry) => entry.connectionId === gap.connectionId,
                )?.label ?? m.products_source_unknown(),
            ),
          )
        : empty();
    case 'status':
      return distinct(
        item.listings.map((listing) => statusLabels[listing.status]),
      );
    case 'published':
      return distinct(
        item.listings.map((listing) =>
          listing.published === null
            ? m.common_not_reported()
            : listing.published
              ? m.common_yes()
              : m.common_no(),
        ),
      );
    case 'vendor':
      return distinct(item.listings.map((listing) => listing.vendor?.trim()));
    case 'price':
      return distinct(
        item.listings.map((listing) => formatPrice(listing.price)),
      );
    case 'barcode':
      return distinct(item.listings.map((listing) => listing.barcode?.trim()));
    case 'bundle':
      return distinct(
        item.listings.map((listing) =>
          listing.requiresComponents === undefined ||
          listing.requiresComponents === null
            ? m.common_not_reported()
            : listing.requiresComponents
              ? m.common_yes()
              : m.common_no(),
        ),
      );
    case 'updated': {
      const latest = item.listings
        .map((listing) => listing.sourceUpdatedAt)
        .filter((value): value is string => !!value)
        .sort()
        .at(-1);

      return latest ? <WorkspaceDate value={latest} /> : empty();
    }
    default:
      return null;
  }
}
