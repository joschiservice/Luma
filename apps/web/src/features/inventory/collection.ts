import type {
  CollectionGranularity,
  CollectionGroup,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';

import type {
  CatalogPresentation,
  RuntimeOptions,
} from '../../kit/collections/fields';
import { collectionGroupLabel } from '../../kit/collections/groups';
import { quantityLabels } from './presentation';

const position = () => m.inventory_area_position();
const quantities = () => m.inventory_area_quantities();
const source = () => m.inventory_area_source();

const differenceLabels: Readonly<Record<string, () => string>> = {
  onHand: m.inventory_quantity_on_hand,
  reserved: m.inventory_quantity_reserved,
  available: m.inventory_quantity_available,
};

const basisLabels: Readonly<Record<string, () => string>> = {
  provider_reported: m.inventory_basis_reported,
  derived: m.inventory_basis_derived,
  unknown: m.common_not_reported,
};

/** How the Inventory list names each catalog field and its options. */
export const inventoryPresentation: CatalogPresentation = {
  sku: { label: m.inventory_filter_sku, group: position },
  location: { label: m.inventory_filter_location, group: position },
  sources: { label: m.inventory_field_sources, group: position },
  source: {
    label: m.inventory_filter_source,
    description: m.inventory_field_source_description,
    group: position,
  },
  differences: {
    label: m.inventory_field_differences,
    description: m.inventory_field_differences_description,
    group: position,
    option: (value) => differenceLabels[value]?.() ?? value,
  },
  sync: {
    label: m.inventory_field_sync,
    description: m.inventory_field_sync_description,
    group: position,
  },
  onHand: { label: quantityLabels.onHand, group: quantities },
  reserved: { label: quantityLabels.reserved, group: quantities },
  available: { label: quantityLabels.available, group: quantities },
  incoming: { label: quantityLabels.incoming, group: quantities },
  belowSafetyStock: {
    label: m.inventory_field_below_safety_stock,
    description: m.inventory_field_below_safety_stock_description,
    group: quantities,
  },
  availabilityBasis: {
    label: m.inventory_field_availability_basis,
    group: source,
    option: (value) => basisLabels[value]?.() ?? value,
  },
  tracked: { label: m.inventory_field_tracked, group: source },
  itemActive: { label: m.inventory_field_item_active, group: source },
  locationActive: { label: m.inventory_field_location_active, group: source },
  lastRead: {
    label: m.inventory_field_last_read,
    description: m.inventory_field_last_read_description,
    group: source,
  },
};

/** Names a built-in Inventory view. */
export function inventorySegmentLabel(segment: string) {
  const labels: Readonly<Record<string, () => string>> = {
    all: m.inventory_view_all,
    differs: m.inventory_view_differs,
    unknown: m.inventory_view_unknown,
  };

  return labels[segment]?.() ?? segment;
}

/** Fields whose group keys are IDs named by options loaded at run time. */
const runtimeGroups: Readonly<Record<string, keyof RuntimeOptions>> = {
  source: 'connections',
  location: 'locations',
};

/**
 * Names one group of the Inventory list: a location or source name, or the SKU's label. Groups
 * key by canonical ID, so `name` looks up labels the rows carry, such as a SKU code.
 */
export function inventoryGroupLabel(
  field: string,
  granularity: CollectionGranularity | undefined,
  key: CollectionGroup['key'],
  options: RuntimeOptions = {},
  name?: (text: string) => string | undefined,
): string {
  return collectionGroupLabel({
    presentation: inventoryPresentation,
    field,
    granularity,
    key,
    options,
    runtime: runtimeGroups,
    name,
  });
}
