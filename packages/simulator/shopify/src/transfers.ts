import { all, gid, insert, type ShopifyContext } from './records.js';
import type {
  ShopifyCommandResult,
  ShopifyInventoryTransfer,
} from './types.js';

/** Replaces a merchant's transfer and shipment evidence atomically without creating inventory adjustments. */
export async function recordInventoryTransfer(
  context: ShopifyContext,
  transfer: ShopifyInventoryTransfer,
): Promise<ShopifyCommandResult> {
  const shipmentIds = transfer.shipments.map((s) => s.id);
  if (new Set(shipmentIds).size !== shipmentIds.length)
    throw new Error('Duplicate shipment identity');
  const lineIds = transfer.lines.map((l) => l.id);
  if (new Set(lineIds).size !== lineIds.length)
    throw new Error('Duplicate transfer line identity');
  for (const shipment of transfer.shipments) {
    const ids = shipment.lines?.map((l) => l.id) ?? [];
    if (new Set(ids).size !== ids.length)
      throw new Error('Duplicate shipment line identity');
  }
  const { id, lines, shipments, ...data } = transfer;
  const previous = await context.store.get('InventoryTransfer', id);
  const record = insert(context, 'InventoryTransfer', id, {
    ...data,
    shipmentIds,
  });
  if (previous) record.createdAt = previous.createdAt;
  const records = [
    record,
    ...lines.map(({ id: lineId, ...line }) =>
      insert(context, 'InventoryTransferLineItem', lineId, line, {
        parent: id,
      }),
    ),
  ];
  const obsolete = await all(context, {
    kind: 'InventoryTransferLineItem',
    parent: id,
  });
  for (const shipment of shipments) {
    const { id: shipmentId, lines: shipmentLines, ...shipmentData } = shipment;
    const old = await context.store.get('InventoryShipment', shipmentId);
    const next = insert(context, 'InventoryShipment', shipmentId, {
      ...shipmentData,
      linesAvailable: shipmentLines !== null,
    });
    if (old) next.createdAt = old.createdAt;
    records.push(
      next,
      ...(shipmentLines ?? []).map(({ id: lineId, ...line }) =>
        insert(context, 'InventoryShipmentLineItem', lineId, line, {
          parent: shipmentId,
        }),
      ),
    );
    obsolete.push(
      ...(await all(context, {
        kind: 'InventoryShipmentLineItem',
        parent: shipmentId,
      })),
    );
  }
  const retained = new Set(records.map((r) => `${r.kind}/${r.id}`));
  if (retained.size !== records.length)
    throw new Error('Duplicate source identity');
  for (const row of records) {
    if (!row.parent) continue;
    const old = await context.store.get(row.kind, row.id);
    if (old && old.parent !== row.parent)
      throw new Error('Line belongs to another source record');
  }
  await context.store.putMany(records);
  for (const row of obsolete)
    if (!retained.has(`${row.kind}/${row.id}`))
      await context.store.delete(row.kind, row.id);

  return { id, gid: gid('InventoryTransfer', id), name: transfer.name };
}
