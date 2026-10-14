import type { StockPosition } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { quantityWithUnit, unitOfMeasure } from '@luma/ui/lib/units';
import { useQuery } from '@tanstack/react-query';

import { PreviewFact } from '../../kit/collections/preview';
import {
  type CollectionValueFilter,
  ValueFilterMenu,
} from '../../kit/collections/value-filter';
import { stockOptions } from './data';
import { inventoryField, inventoryLabel, stockQuantities } from './fields';
import {
  quantityLabels,
  stockFreshness,
  stockQuantity,
  StockState,
} from './presentation';

/** Related records the preview lists before pointing to the full position. */
const previewRelated = 5;

/**
 * A compact summary of the position open beside the list: its state and each source's quantities
 * from the list row, then affected orders, purchase orders and issues from the detail read.
 * `filter` offers "Show only this value" and "Hide this value" on the location and each source.
 */
export function InventoryPreview({
  organizationId,
  positionId,
  position,
  asOf,
  filter,
}: {
  organizationId: string;
  positionId: string;
  /** The position's list row, when it is on the current page. */
  position: StockPosition | undefined;
  /** When the list was read, for read ages until the detail arrives. */
  asOf: string;
  filter?: CollectionValueFilter | undefined;
}) {
  const detail = useQuery(stockOptions(organizationId, positionId));
  const shown = position ?? detail.data?.position;
  const readAt = detail.data?.asOf ?? asOf;
  const menu = (field: string, value: string, text: string) =>
    filter ? (
      <ValueFilterMenu
        field={field}
        value={value}
        label={m.inventory_preview_filter({ value: text })}
        filter={filter}
      />
    ) : null;

  return (
    <div className="collection-preview-body">
      {shown ? (
        <>
          <StockState position={shown} />
          <dl className="collection-preview-facts">
            <PreviewFact
              label={inventoryLabel('location')}
              menu={menu('location', shown.locationId, shown.location)}
            >
              {shown.location}
            </PreviewFact>
            <PreviewFact label={m.inventory_preview_unit()}>
              {unitOfMeasure(shown.unit)}
            </PreviewFact>
            <PreviewFact label={inventoryLabel('differences')}>
              {inventoryField(shown, 'differences', readAt)}
            </PreviewFact>
          </dl>
          <section>
            <h3 className="collection-preview-heading">
              {m.inventory_preview_sources()}
            </h3>
            <dl className="collection-preview-facts">
              {shown.sources.map((source) => (
                <PreviewFact
                  key={source.connectionId}
                  label={source.label}
                  menu={menu('source', source.connectionId, source.label)}
                >
                  <span className="inventory-preview-source">
                    {stockQuantities.map((field) => (
                      <span key={field}>
                        {m.inventory_preview_quantity({
                          quantity: quantityLabels[field](),
                          value: source.deleted
                            ? m.common_empty_value()
                            : stockQuantity(source[field]),
                        })}
                      </span>
                    ))}
                    <small>{stockFreshness(source, readAt)}</small>
                  </span>
                </PreviewFact>
              ))}
            </dl>
          </section>
        </>
      ) : null}
      {detail.data ? (
        <>
          <section>
            <h3 className="collection-preview-heading">
              {m.inventory_preview_orders()}
            </h3>
            {detail.data.orders.length ? (
              <ul className="collection-preview-lines">
                {detail.data.orders.slice(0, previewRelated).map((order) => (
                  <li key={`${order.id}:${order.connectionId}`}>
                    <span>{order.label}</span>
                    <span>
                      {quantityWithUnit(
                        stockQuantity(order.quantity),
                        order.unit,
                        order.quantity,
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="collection-preview-note">
                {m.inventory_orders_empty()}
              </p>
            )}
          </section>
          {detail.data.purchaseOrders.length ? (
            <section>
              <h3 className="collection-preview-heading">
                {m.inventory_preview_purchase_orders()}
              </h3>
              <ul className="collection-preview-lines">
                {detail.data.purchaseOrders
                  .slice(0, previewRelated)
                  .map((order) => (
                    <li key={order.id}>
                      <span>{order.label}</span>
                      <span>
                        {quantityWithUnit(
                          stockQuantity(String(order.quantity)),
                          order.unit,
                          order.quantity,
                        )}
                      </span>
                    </li>
                  ))}
              </ul>
            </section>
          ) : detail.isPending ? (
            <p role="status" className="collection-preview-note">
              {m.inventory_detail_loading()}
            </p>
          ) : detail.isError ? (
            <Alert role="status">{m.inventory_preview_unavailable()}</Alert>
          ) : null}
          {detail.data.issues.length ? (
            <p className="collection-preview-note">
              {m.inventory_preview_issues({
                count: detail.data.issues.length,
              })}
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
