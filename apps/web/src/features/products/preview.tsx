import type { CatalogItem, CatalogSource } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { quantityUnit } from '@luma/ui/lib/units';
import { useQuery } from '@tanstack/react-query';

import { PreviewFact } from '../../kit/collections/preview';
import {
  type CollectionValueFilter,
  ValueFilterMenu,
} from '../../kit/collections/value-filter';
import { formatSourceNumber } from '../../shared/orders/presentation';
import { stockQuantity } from '../inventory/presentation';
import { productsPresentation } from './collection';
import { productOptions } from './data';
import { productField, ProductFlags } from './fields';
import {
  differenceSentence,
  formatPrice,
  gapText,
  statusLabels,
} from './presentation';

/** Stock positions the preview lists before pointing to the full product. */
const previewPositions = 5;

const label = (key: string) => productsPresentation[key]?.label() ?? key;

/**
 * A compact summary of the SKU open beside the list: its comparison state and each source's
 * listing from the list row, then why sources differ, stock positions and 30 days of units
 * ordered from the detail read. `filter` offers "Show only this value" and "Hide this value" on
 * each listing's source and status.
 */
export function ProductPreview({
  organizationId,
  skuId,
  item,
  sources,
  asOf,
  filter,
}: {
  organizationId: string;
  skuId: string;
  /** The SKU's list row, when it is on the current page. */
  item: CatalogItem | undefined;
  sources: CatalogSource[];
  /** When the list was read, for read ages until the detail arrives. */
  asOf: string;
  filter?: CollectionValueFilter | undefined;
}) {
  const detail = useQuery(productOptions(organizationId, skuId));
  const shown = item ?? detail.data?.item;
  const known = detail.data?.sources ?? sources;
  const context = { sources: known, asOf: detail.data?.asOf ?? asOf };
  const menu = (field: string, value: string, text: string) =>
    filter ? (
      <ValueFilterMenu
        field={field}
        value={value}
        label={m.products_preview_filter({ value: text })}
        filter={filter}
      />
    ) : null;
  const sourceName = (connectionId: string) =>
    known.find((source) => source.connectionId === connectionId)?.label ??
    m.products_source_unknown();

  return (
    <div className="collection-preview-body">
      {shown ? (
        <>
          <ProductFlags item={shown} sources={known} />
          <dl className="collection-preview-facts">
            {(['title', 'listings', 'vendor', 'updated'] as const).map(
              (key) => (
                <PreviewFact key={key} label={label(key)}>
                  {productField(shown, key, context)}
                </PreviewFact>
              ),
            )}
          </dl>
          {shown.differences.length ? (
            <p className="collection-preview-note">
              {differenceSentence(shown.differences)}
            </p>
          ) : null}
          <section>
            <h3 className="collection-preview-heading">
              {m.products_preview_listings()}
            </h3>
            <dl className="collection-preview-facts">
              {known.map((source) => {
                const listing = shown.listings.find(
                  (entry) => entry.connectionId === source.connectionId,
                );
                const gap = shown.gaps.find(
                  (entry) => entry.connectionId === source.connectionId,
                );

                return (
                  <PreviewFact
                    key={source.connectionId}
                    label={source.label}
                    menu={menu(
                      listing ? 'listings' : 'missing',
                      source.connectionId,
                      source.label,
                    )}
                  >
                    {listing
                      ? m.products_preview_listing({
                          status: statusLabels[listing.status],
                          price:
                            formatPrice(listing.price) ??
                            m.products_listing_no_price(),
                        })
                      : gap
                        ? gapText(gap, source, context.asOf)
                        : m.products_listing_not_in_catalog()}
                  </PreviewFact>
                );
              })}
            </dl>
          </section>
        </>
      ) : null}
      {detail.data ? (
        <>
          <section>
            <h3 className="collection-preview-heading">
              {m.products_preview_stock()}
            </h3>
            {detail.data.stock.length ? (
              <ul className="collection-preview-lines">
                {detail.data.stock
                  .slice(0, previewPositions)
                  .map((position) => (
                    <li key={position.id}>
                      <span>{position.location}</span>
                      <span>
                        {position.sources
                          .map(
                            (source) =>
                              `${source.label}: ${stockQuantity(source.available)}`,
                          )
                          .join(' · ')}
                      </span>
                    </li>
                  ))}
              </ul>
            ) : (
              <p className="collection-preview-note">
                {m.products_stock_empty()}
              </p>
            )}
            {detail.data.stock.length > previewPositions ? (
              <p className="collection-preview-note">
                {m.common_count_more({
                  count: detail.data.stock.length - previewPositions,
                })}
              </p>
            ) : detail.isPending ? (
              <p role="status" className="collection-preview-note">
                {m.products_detail_loading()}
              </p>
            ) : detail.isError ? (
              <Alert role="status">{m.products_preview_unavailable()}</Alert>
            ) : null}
          </section>
          <section>
            <h3 className="collection-preview-heading">
              {m.products_preview_sales()}
            </h3>
            {detail.data.sales.sources.length ? (
              <ul className="collection-preview-lines">
                {detail.data.sales.sources.map((sales) => (
                  <li key={`${sales.connectionId}:${sales.unit}`}>
                    <span>{sourceName(sales.connectionId)}</span>
                    <span>
                      {m.products_sales_summary({
                        quantity: formatSourceNumber(sales.quantity),
                        unit: quantityUnit(sales.unit, sales.quantity),
                        orders: sales.orders,
                      })}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="collection-preview-note">
                {m.products_sales_empty()}
              </p>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
