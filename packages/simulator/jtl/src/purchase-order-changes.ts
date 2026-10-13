import { isDate } from './purchasing.js';
import {
  type AssignmentRecord,
  type ItemRecord,
  type JtlContext,
  kinds,
  type PurchaseOrderRecord,
  refuse,
} from './records.js';

/** Mirrors JTL's one-position structural writes; completed and received orders cannot be revised. */
export async function revisePurchaseOrder(
  context: JtlContext,
  orderId: string,
  method: 'PATCH' | 'POST' | 'DELETE',
  lineId: string | undefined,
  input: unknown,
) {
  const row = await context.store.get<PurchaseOrderRecord>(
    kinds.purchaseOrder,
    orderId,
  );
  if (!row) refuse('Purchase order not found', 404);
  const order = row.data;
  if (![0, 5].includes(order.status))
    refuse('Purchase order is no longer Open or Released', 409);
  if (!input || typeof input !== 'object' || Array.isArray(input))
    refuse('Invalid order revision');
  const body: Record<string, unknown> = Object.fromEntries(
    Object.entries(input),
  );
  if (method === 'POST') {
    if (
      lineId ||
      typeof body.itemId !== 'string' ||
      typeof body.quantity !== 'number' ||
      !Number.isFinite(body.quantity) ||
      body.quantity <= 0 ||
      !isDate(body.deliveryDate) ||
      order.lineItems.some((line) => line.itemId === body.itemId)
    )
      refuse('Invalid added line');
    const item = await context.store.get<ItemRecord>(kinds.item, body.itemId);
    if (!item) refuse('Item not found', 404);
    const assignment = (
      await context.store.page<AssignmentRecord>({
        kind: kinds.assignment,
        parent: body.itemId,
        key: order.supplierId,
        limit: 1,
      })
    ).items[0]?.data;
    if (!assignment) refuse('Item not assigned to supplier', 409);
    const price = body.netPurchasePriceAmount ?? assignment.netPrice,
      vat = body.vatRatePercentage ?? assignment.vatRate;
    if (
      typeof price !== 'number' ||
      !Number.isFinite(price) ||
      price < 0 ||
      typeof vat !== 'number' ||
      !Number.isFinite(vat) ||
      vat < 0
    )
      refuse('Invalid price');
    const id = String(
      Math.max(0, ...order.lineItems.map((line) => Number(line.lineItemId))) +
        1,
    );
    order.lineItems.push({
      lineItemId: id,
      lineItemType: 1,
      itemId: item.id,
      itemNumber: item.data.sku,
      name: item.data.name,
      quantity: body.quantity,
      deliveredQuantity: 0,
      openQuantity: body.quantity,
      netPurchasePriceAmount: price,
      vatRatePercentage: vat,
      sortOrder: order.lineItems.length + 1,
      deliveryDate: String(body.deliveryDate),
      confirmedQuantity: null,
      confirmedDeliveryDate: null,
      isLineItemConfirmed: null,
    });
  } else {
    const line = order.lineItems.find((value) => value.lineItemId === lineId);
    if (!line) refuse('Purchase order line not found', 404);
    if (line.deliveredQuantity > 0)
      refuse('Received positions cannot be revised', 409);
    if (method === 'DELETE') {
      if (order.lineItems.length <= 1)
        refuse('Cannot remove the final position', 409);
      order.lineItems = order.lineItems.filter(
        (value) => value.lineItemId !== line.lineItemId,
      );
    } else {
      if (body.quantity !== undefined) {
        if (
          typeof body.quantity !== 'number' ||
          !Number.isFinite(body.quantity) ||
          body.quantity <= 0
        )
          refuse('Invalid quantity');
        line.quantity = body.quantity;
        line.openQuantity = body.quantity;
      }
      if (body.deliveryDate !== undefined) {
        if (!isDate(body.deliveryDate)) refuse('Invalid delivery date');
        line.deliveryDate = String(body.deliveryDate);
      }
      if (body.quantity === undefined && body.deliveryDate === undefined)
        refuse('No structural change supplied');
    }
  }
  await context.store.put(kinds.purchaseOrder, orderId, order, {
    updatedAt: context.now,
  });
  context.notify({
    topic: 'purchase-orders/update',
    resource: orderId,
    payload: { purchaseOrderId: orderId, status: order.status },
  });

  return order;
}
