import type { TransferData } from '@luma/inventory';

import { normalizers, type Planner } from '../planning.js';

/** Plans an inventory transfer; unmapped locations and SKUs stay as source references. */
export const planInventoryTransfer: Planner<
  'inventory.transfers.read'
> = async (input, { lookup, resolve, missing, provenance, digest }) => {
  const o = input.observation;
  const data = input.observation.data;
  const entityId = await resolve('inventory_transfer', o.source);
  if (!entityId) return { status: 'pending', missing };
  const mappedLocation = async (location: typeof data.origin) =>
    location
      ? {
          sourceId: location.id,
          locationId: location.id
            ? ((await lookup({
                ...o.source,
                ...location.id,
                resource: 'location',
              })) ?? null)
            : null,
          name: location.name,
          snapshottedAt: location.snapshottedAt,
          address: location.address,
        }
      : null;
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
            title: line.title,
            unit: line.unit,
            requested: line.requested,
            picked: line.picked,
            ready: line.ready,
            shipped: line.shipped,
          })),
        );
  const normalized: TransferData = {
    type: 'inventory_transfer',
    name: data.name,
    status: data.status,
    createdAt: data.createdAt,
    origin: await mappedLocation(data.origin),
    destination: await mappedLocation(data.destination),
    requestedQuantity: data.requestedQuantity,
    receivedQuantity: data.receivedQuantity,
    lines,
    shipmentSources: data.shipments,
  };

  return {
    owner: 'inventory',
    snapshot: {
      ...provenance,
      entityId,
      kind: 'inventory_transfer',
      normalizerVersion: normalizers.inventoryTransfers,
      mappingVersion: digest(
        JSON.stringify([
          entityId,
          normalized.origin?.locationId ?? null,
          normalized.destination?.locationId ?? null,
          lines?.map((line) => line.skuId) ?? null,
        ]),
      ),
      data: normalized,
    },
  };
};
