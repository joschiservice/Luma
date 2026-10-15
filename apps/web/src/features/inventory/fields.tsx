import type { StockPosition } from '@luma/api-contract';
import { formatList } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { unitOfMeasure } from '@luma/ui/lib/units';
import type { ReactNode } from 'react';

import { connectionStatusLabel } from '../../shared/orders/presentation';
import { inventoryPresentation } from './collection';
import {
  quantityLabels,
  stockFreshness,
  stockQuantity,
  StockSyncWindow,
} from './presentation';

/** Quantities a position compares across sources, in column order. */
export const stockQuantities = [
  'onHand',
  'reserved',
  'available',
  'incoming',
] as const;

type StockQuantity = (typeof stockQuantities)[number];

const empty = () => m.common_empty_value();

/** One row per source with that source's quantity; differing quantities are marked. */
function SourceQuantities({
  position,
  field,
}: {
  position: StockPosition;
  field: StockQuantity;
}) {
  return (
    <div className="inventory-source-stack">
      {position.sources.map((source) => (
        <div key={source.connectionId}>
          <span
            className={
              position.differences.some((value) => value === field)
                ? 'inventory-difference'
                : undefined
            }
          >
            {source.deleted
              ? m.common_empty_value()
              : stockQuantity(source[field])}
          </span>
          <small>
            {field === 'available'
              ? source.availabilityBasis === 'derived'
                ? m.inventory_basis_derived()
                : source.availabilityBasis === 'provider_reported'
                  ? m.inventory_basis_reported()
                  : m.common_not_reported()
              : ' '}
          </small>
        </div>
      ))}
    </div>
  );
}

/** Each source of a position with how fresh its read is and its connection's state. */
function PositionSources({
  position,
  asOf,
}: {
  position: StockPosition;
  asOf: string;
}) {
  return (
    <div className="inventory-source-stack">
      {position.sources.map((source) => (
        <div key={source.connectionId}>
          <strong>{source.label}</strong>
          {source.bundleContext ? (
            <small>{m.products_bundles_parent()}</small>
          ) : null}
          <small>
            {stockFreshness(source, asOf)} ·{' '}
            {connectionStatusLabel(source.status)}
          </small>
        </div>
      ))}
    </div>
  );
}

/**
 * A quantity as each source reports it, on one line for list rows, such as "Available: Tokyo
 * store 3 · JTL-Wawi 5".
 */
function quantityLine(position: StockPosition, field: StockQuantity) {
  return m.inventory_quantity_line({
    quantity: quantityLabels[field](),
    values: position.sources.length
      ? position.sources
          .map((source) =>
            m.inventory_source_quantity({
              source: source.label,
              quantity: source.deleted
                ? m.common_empty_value()
                : stockQuantity(source[field]),
            }),
          )
          .join(' · ')
      : empty(),
  });
}

/**
 * Renders one Inventory catalog field of a position, for table cells, list properties and the
 * preview. Quantities stay per source; a missing value is "Not reported", never zero.
 */
export function inventoryField(
  position: StockPosition,
  key: string,
  asOf: string,
): ReactNode {
  switch (key) {
    case 'sku':
      return position.sku;
    case 'location':
      return position.location;
    case 'sources':
      return <PositionSources position={position} asOf={asOf} />;
    case 'onHand':
    case 'reserved':
    case 'available':
    case 'incoming':
      return <SourceQuantities position={position} field={key} />;
    case 'differences':
      return position.differences.length
        ? formatList(
            position.differences.map(
              (field) => quantityLabels[field]?.() ?? field,
            ),
          )
        : empty();
    case 'sync':
      return position.sync ? <StockSyncWindow position={position} /> : empty();
    case 'unit':
      return unitOfMeasure(position.unit);
    default:
      return null;
  }
}

/**
 * Renders a field for list rows, where each property is one line: quantities name their sources
 * inline and sources list their names.
 */
export function inventoryProperty(
  position: StockPosition,
  key: string,
  asOf: string,
): ReactNode {
  if ((stockQuantities as readonly string[]).includes(key))
    return quantityLine(position, key as StockQuantity);
  if (key === 'sources')
    return formatList(position.sources.map((source) => source.label));

  return inventoryField(position, key, asOf);
}

/** The label of a property, for list rows and the preview. */
export function inventoryLabel(key: string) {
  return inventoryPresentation[key]?.label() ?? key;
}
