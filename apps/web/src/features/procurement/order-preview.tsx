import { m } from '@luma/i18n/messages';
import { quantityWithUnit } from '@luma/ui/lib/units';

import { purchaseOrdersPresentation } from './collection';
import {
  type ListedPurchaseOrder,
  type LocationNames,
  purchaseOrderField,
  PurchaseOrderFlags,
} from './fields';
import { quantity } from './presentation';

/** Lines the preview lists before pointing to the full order. */
const previewLines = 5;

const facts = [
  'supplier',
  'stage',
  'attention',
  'nextOwner',
  'expected',
  'confirmationDue',
  'nextCheck',
  'value',
  'status',
  'number',
  'updated',
] as const;

/**
 * A compact summary of the purchase order open beside the list, from its list row: the open-item
 * flag, its stage and dates as Luma last evaluated them, and its first lines. The record page
 * holds evidence, commitments and actions.
 */
export function PurchaseOrderPreview({
  order,
  locations,
}: {
  /** The order's list row; undefined while the open order is not on this page. */
  order: ListedPurchaseOrder | undefined;
  locations?: LocationNames | undefined;
}) {
  if (!order)
    return (
      <p role="status" className="procurement-muted">
        {m.procurement_list_loading_orders()}
      </p>
    );

  return (
    <div className="procurement-preview">
      <PurchaseOrderFlags order={order} />
      <dl className="procurement-preview-facts">
        {facts.map((key) => (
          <div key={key}>
            <dt>{purchaseOrdersPresentation[key]?.label() ?? key}</dt>
            <dd>{purchaseOrderField(order, key, locations)}</dd>
          </div>
        ))}
      </dl>
      <section>
        <h3 className="procurement-preview-heading">
          {m.procurement_area_lines()}
        </h3>
        <ul className="procurement-preview-lines">
          {order.lines.slice(0, previewLines).map((line) => (
            <li key={line.id}>
              <span>
                {line.sku} · {line.description}
              </span>
              <span>
                {quantityWithUnit(
                  quantity(line.quantity),
                  line.unit,
                  line.quantity,
                )}
              </span>
            </li>
          ))}
        </ul>
        {order.lines.length > previewLines ? (
          <p className="procurement-muted">
            {m.common_count_more({ count: order.lines.length - previewLines })}
          </p>
        ) : null}
      </section>
    </div>
  );
}
