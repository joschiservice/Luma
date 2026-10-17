import type { ShipmentData } from '@luma/inventory';

import { normalizers, type Planner } from '../planning.js';

/** Plans an inventory shipment; unmapped SKUs stay as source references. */
export const planInventoryShipment: Planner<
  'inventory.shipments.read'
> = async (input, { lookup, resolve, missing, provenance, digest }) => {
  const o = input.observation;
  const data = input.observation.data;
  const entityId = await resolve('inventory_shipment', o.source);
  if (!entityId) return { status: 'pending', missing };
  const lines =
    data.lines === null
      ? null
      : await Promise.all(
          data.lines.map(async (line) => ({
            sourceId: line.id,
            sourceSku: line.sku,
            skuId: line.sku
              ? ((await lookup({
                  ...o.source,
                  ...line.sku,
                  resource: 'sku',
                })) ?? null)
              : null,
            unit: line.unit,
            quantity: line.quantity,
            accepted: line.accepted,
            rejected: line.rejected,
            unreceived: line.unreceived,
          })),
        );
  const normalized: ShipmentData = {
    ...data,
    type: 'inventory_shipment',
    lines,
  };

  return {
    owner: 'inventory',
    snapshot: {
      ...provenance,
      entityId,
      kind: 'inventory_shipment',
      normalizerVersion: normalizers.inventoryShipments,
      mappingVersion: digest(
        JSON.stringify([entityId, lines?.map((line) => line.skuId) ?? null]),
      ),
      data: normalized,
    },
  };
};
