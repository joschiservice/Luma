import type { CapabilityInput } from '@luma/connections';
import { fail } from '@luma/connector-shopify';

import { inventoryCompositionSelection } from './read-selections.js';
import { type ReadSession, ref } from './read-session.js';
import * as s from './schemas.js';

/**
 * Emits one inventory item's levels, optionally limited to one location. Untracked items
 * report no quantities; composition is read only when requested.
 */
export async function readInventoryItem(
  session: ReadSession,
  parent: { id: string },
  filters: Pick<
    CapabilityInput<'inventory.read'>,
    'includeComposition' | 'location'
  >,
) {
  const { node, children, emit } = session;
  const item = await node(
    parent.id,
    'InventoryItem',
    `id tracked ${filters.includeComposition ? inventoryCompositionSelection : ''}`,
    s.inventoryItem,
  );
  const levels = await children(
    parent.id,
    'InventoryItem',
    'inventoryLevels',
    'id updatedAt isActive location { id isActive } quantities(names: ["on_hand", "committed", "reserved", "incoming", "damaged", "quality_control", "safety_stock", "available"]) { name quantity }',
    s.level,
  );
  let composition;
  if (filters.includeComposition) {
    if (item.variant === undefined) fail('invalid_response');
    if (
      item.variant &&
      item.variant.productVariantComponents.nodes.length === 0 &&
      item.variant.productVariantComponents.pageInfo.hasNextPage
    )
      fail('invalid_response');
    composition = item.variant
      ? {
          variant: ref(item.variant.id),
          requiresComponents: item.variant.requiresComponents,
          hasComponents: item.variant.productVariantComponents.nodes.length > 0,
        }
      : null;
  }
  for (const level of levels) {
    if (filters.location && filters.location.externalId !== level.location.id)
      continue;
    const values = new Map(
      level.quantities.map((value) => [value.name, String(value.quantity)]),
    );
    if (values.size !== level.quantities.length) fail('invalid_response');
    const value = (key: string) =>
      item.tracked ? (values.get(key) ?? null) : null;
    const available = value('available');
    emit('sku', ref(item.id, level.location.id), level.updatedAt, {
      ...(composition === undefined ? {} : { composition }),
      sku: ref(item.id),
      location: ref(level.location.id),
      unit: 'each',
      onHand: value('on_hand'),
      reserved: value('reserved'),
      committed: value('committed'),
      incoming: value('incoming'),
      damaged: value('damaged'),
      qualityControl: value('quality_control'),
      safetyStock: value('safety_stock'),
      locationActive: level.location.isActive ?? null,
      itemActive: level.isActive ?? null,
      tracked: item.tracked,
      inventorySemantics: 'shopify/1',
      available,
      availabilityBasis: available === null ? 'unknown' : 'provider_reported',
    });
  }
}
