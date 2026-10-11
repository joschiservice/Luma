import type { RecordPage } from '@luma/simulator-core';

import {
  COMPANY_ID,
  configId,
  iso,
  type JtlContext,
  kinds,
  next,
  type OrderRecord,
  recordId,
  refuse,
  type ReturnRecord,
} from './records.js';
import { defaultReturnReasons } from './types.js';

// JTL rejects request fields its schema does not define.
const returnFields = new Set([
  'returnDate',
  'externalNumber',
  'companyId',
  'salesOrderId',
  'warehouseId',
  'externalComment',
  'internalComment',
  'contact',
  'items',
  'packages',
  'transmitToSalesChannel',
]);

const lineFields = new Set([
  'quantity',
  'returnReasonId',
  'returnReasonComment',
  'credit',
  'salesOrderLineItemId',
  'deliveryNoteLineItemId',
]);

/** The return reasons the instance offers. */
export const returnReasons = (context: JtlContext) =>
  context.config.returnReasons ?? defaultReturnReasons;

const object = (value: unknown) =>
  (typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value
    : {}) as Record<string, unknown>;

const optionalText = (value: unknown, max: number) =>
  value === undefined || value === null
    ? null
    : typeof value === 'string' && value.length <= max
      ? value
      : undefined;

/** Units of each order line already booked in returns, by line ID. */
async function returnedUnits(context: JtlContext, orderId: string) {
  const returned = new Map<string, number>();
  let after: string | null = null;
  do {
    const page: RecordPage<ReturnRecord> =
      await context.store.page<ReturnRecord>({
        kind: kinds.return,
        parent: orderId,
        after,
        limit: 500,
      });
    for (const record of page.items)
      for (const line of record.data.lines)
        returned.set(
          line.orderLineId,
          (returned.get(line.orderLineId) ?? 0) + line.quantity,
        );
    after = page.next;
  } while (after);

  return returned;
}

/**
 * Creates a return from an API request body like JTL: the order must exist in the company and
 * not be cancelled, the warehouse and reasons must exist, and every line must name a line of the
 * order with a positive quantity no larger than its ordered units not yet returned. A repeated
 * Idempotency-Key returns the recorded return without creating another; `created` is false
 * then. Invalid requests throw a 400 refusal.
 */
export async function createReturn(
  context: JtlContext,
  body: unknown,
  key: string | undefined,
) {
  if (key !== undefined && (key.length < 1 || key.length > 255))
    refuse('Invalid Idempotency-Key');
  if (key) {
    const recorded = await context.store.get<{ returnId: string }>(
      kinds.returnKey,
      key,
    );
    if (recorded) {
      const existing = await context.store.get<ReturnRecord>(
        kinds.return,
        recorded.data.returnId,
      );
      if (existing) return { record: existing.data, created: false };
    }
  }
  const input = object(body);
  const orderId = recordId(input.salesOrderId);
  const order = orderId
    ? (await context.store.get<OrderRecord>(kinds.order, orderId))?.data
    : undefined;
  const warehouse = recordId(input.warehouseId);
  const externalNumber = optionalText(input.externalNumber, 255);
  const internalComment = optionalText(input.internalComment, 4000);
  const rows = input.items;
  if (
    Object.keys(input).some((field) => !returnFields.has(field)) ||
    recordId(input.companyId) !== COMPANY_ID ||
    !order ||
    !warehouse ||
    !context.config.warehouses.some((w) => w.id === warehouse) ||
    !Array.isArray(rows) ||
    !rows.length ||
    rows.length > 500 ||
    externalNumber === undefined ||
    internalComment === undefined
  )
    refuse('Invalid return');
  if (order.cancelled) refuse('Sales order is cancelled');
  const returned = await returnedUnits(context, order.id);
  const reasons = returnReasons(context);
  const accepted: {
    line: OrderRecord['lines'][number];
    quantity: number;
    reasonId: string;
    credit: boolean;
  }[] = [];
  for (const value of rows as unknown[]) {
    const row = object(value);
    const line = order.lines.find(
      (candidate) => candidate.id === recordId(row.salesOrderLineItemId),
    );
    const reasonId = recordId(row.returnReasonId);
    const { quantity, credit } = row;
    if (
      Object.keys(row).some((field) => !lineFields.has(field)) ||
      !line ||
      !reasonId ||
      !reasons.some((reason) => reason.id === reasonId) ||
      (credit !== undefined && typeof credit !== 'boolean') ||
      typeof quantity !== 'number' ||
      !(quantity > 0)
    )
      refuse('Invalid return line');
    const booked = returned.get(line.id) ?? 0;
    if (booked + quantity > line.quantity)
      refuse('Quantity exceeds the units left to return');
    returned.set(line.id, booked + quantity);
    accepted.push({ line, quantity, reasonId, credit: credit ?? false });
  }
  const id = await next(context, kinds.return);
  const lines: ReturnRecord['lines'] = [];
  for (const { line, quantity, reasonId, credit } of accepted)
    lines.push({
      id: await next(context, 'return-line'),
      orderLineId: line.id,
      itemId: line.itemId,
      sku: line.sku,
      name: line.name,
      quantity,
      reasonId,
      credit,
    });
  const record: ReturnRecord = {
    id,
    number: `RE-${id.padStart(5, '0')}`,
    orderId: order.id,
    customerId: order.customerId ?? null,
    warehouse,
    externalNumber,
    internalComment,
    date: iso(context.now),
    lines,
  };
  await context.store.put(kinds.return, id, record, {
    parent: order.id,
    createdAt: context.now,
    updatedAt: context.now,
  });
  if (key)
    await context.store.put(
      kinds.returnKey,
      key,
      { returnId: id },
      { createdAt: context.now, updatedAt: context.now },
    );
  context.notify({
    topic: 'returns/create',
    resource: id,
    payload: { returnId: id, salesOrderId: order.id },
  });

  return { record, created: true };
}

/** Serializes a return in ERP API 2.2 field names. */
export function returnJson(record: ReturnRecord) {
  return {
    id: Number(record.id),
    number: record.number,
    returnDate: record.date,
    customerId: record.customerId ? Number(record.customerId) : 0,
    externalNumber: record.externalNumber ?? '',
    // 7: created through the REST API.
    origin: 7,
    companyId: Number(COMPANY_ID),
    salesOrderId: Number(record.orderId),
    stateId: 1,
    warehouseId: configId(record.warehouse),
    externalComment: '',
    internalComment: record.internalComment ?? '',
    contact: '',
    transmitToSalesChannel: false,
  };
}

/** Serializes the line items of a return. */
export function returnLinesJson(record: ReturnRecord) {
  return record.lines.map((line) => ({
    id: Number(line.id),
    returnId: Number(record.id),
    stateId: 1,
    itemId: Number(line.itemId),
    name: line.name,
    sKU: line.sku,
    quantity: line.quantity,
    returnReasonId: configId(line.reasonId),
    conditionId: 0,
    conditionComment: '',
    credit: line.credit,
    salesOrderId: Number(record.orderId),
    salesOrderLineItemId: Number(line.orderLineId),
    deliveryNoteLineItemId: 0,
  }));
}

/** Serializes the return reasons with German and English names. */
export function returnReasonsJson(context: JtlContext) {
  return returnReasons(context).map((reason) => ({
    id: configId(reason.id),
    translations: [
      { languageIso: 'de', name: reason.germanName ?? reason.name },
      { languageIso: 'en', name: reason.name },
    ],
  }));
}
