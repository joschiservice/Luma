import { normalizers, type Planner, sourceOrder } from '../planning.js';

/**
 * Plans a return or refund once it, its order and its order lines are mapped, and the same
 * source has projected the order.
 */
export const planReturn: Planner<'returns.read'> = async (input, scope) => {
  const { resolve, missing, provenance, digest } = scope;
  const o = input.observation;
  const data = input.observation.data;
  const entityId = await resolve(data.type, o.source),
    orderId = await resolve('order', data.order);
  const lineIds: (string | null)[] = [];
  for (const line of data.lines)
    lineIds.push(
      line.orderLine ? await resolve('order_line', line.orderLine) : null,
    );
  const returnId =
    data.type === 'refund' && data.return
      ? await resolve('return', data.return)
      : null;
  if (!entityId || !orderId || missing.length)
    return { status: 'pending', missing };
  if (!(await sourceOrder(scope, orderId, o.source.connectionId)))
    return {
      status: 'pending',
      missing: [{ ...o.source, ...data.order, resource: 'order' }],
    };
  const common = {
    ...provenance,
    normalizerVersion: normalizers[data.type],
    entityId,
    mappingVersion: digest(
      JSON.stringify([entityId, orderId, lineIds, returnId]),
    ),
  };

  return {
    owner: 'orders',
    snapshot:
      data.type === 'return'
        ? {
            ...common,
            kind: 'return',
            data: {
              type: 'return',
              orderId,
              name: data.name,
              status: data.status,
              requestedAt: data.requestedAt,
              approvedAt: data.approvedAt,
              closedAt: data.closedAt,
              declineReason: data.declineReason,
              receivedAt: data.receivedAt,
              lines: data.lines.map((line, index) => ({
                orderLineId: lineIds[index] ?? null,
                quantity: line.quantity.amount,
                unit: line.quantity.unit,
                reason: line.reason,
                receivedQuantity: line.receivedQuantity,
                restockedQuantity: line.restockedQuantity,
                refundedQuantity: line.refundedQuantity,
                value: line.value,
              })),
            },
          }
        : {
            ...common,
            kind: 'refund',
            data: {
              type: 'refund',
              orderId,
              returnId,
              createdAt: data.createdAt,
              total: data.total,
              lines: data.lines.map((line, index) => ({
                orderLineId: lineIds[index]!,
                quantity: line.quantity.amount,
                unit: line.quantity.unit,
                restock: line.restock,
                restocked: line.restocked,
              })),
              transactions: data.transactions,
            },
          },
  };
};
