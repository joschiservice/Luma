import { normalizers, type Planner, sourceOrder } from '../planning.js';

/**
 * Plans a fulfillment once it, its order and its order lines are mapped, and the same source has
 * projected the order. Throws when a line doesn't belong to that order or changes its unit.
 */
export const planFulfillment: Planner<'fulfillment.read'> = async (
  input,
  scope,
) => {
  const { lookup, resolve, missing, provenance, digest } = scope;
  const o = input.observation;
  const data = input.observation.data;
  const entityId = await resolve('fulfillment', o.source),
    orderId = await resolve('order', data.order);
  const lines = [];
  for (const line of data.lines) {
    const orderLineId = await resolve('order_line', line.orderLine);
    if (orderLineId)
      lines.push({
        orderLineId,
        quantity: line.quantity.amount,
        unit: line.quantity.unit,
        ...(line.remainingQuantity === undefined
          ? {}
          : { remainingQuantity: line.remainingQuantity?.amount ?? null }),
      });
  }
  // An unknown location does not prevent storing fulfillment facts.
  const locationId = data.location
    ? await lookup({ ...o.source, ...data.location.id, resource: 'location' })
    : null;
  if (!entityId || !orderId || missing.length)
    return { status: 'pending', missing };
  const order = await sourceOrder(scope, orderId, o.source.connectionId);
  if (!order)
    return {
      status: 'pending',
      missing: [{ ...o.source, ...data.order, resource: 'order' }],
    };
  if (
    lines.some(
      (l) =>
        !order.lines.some((p) => p.id === l.orderLineId && p.unit === l.unit),
    )
  )
    throw new Error(
      'Fulfillment line must belong to its order and use the same unit',
    );
  const optional = <K extends keyof typeof data>(key: K) =>
    data[key] === undefined ? {} : { [key]: data[key] };

  return {
    owner: 'orders',
    snapshot: {
      ...provenance,
      schemaVersion: 5,
      normalizerVersion: normalizers.fulfillment,
      entityId,
      kind: 'fulfillment',
      mappingVersion: digest(
        JSON.stringify([
          entityId,
          orderId,
          lines.map((l) => l.orderLineId),
          locationId,
        ]),
      ),
      data: {
        type: 'fulfillment',
        ...optional('milestones'),
        orderId,
        status: data.status,
        lastProgressAt: data.lastProgressAt,
        failureCode: data.failureCode,
        lines,
        ...optional('kind'),
        ...optional('holds'),
        ...(data.location === undefined
          ? {}
          : {
              location: data.location
                ? { locationId, name: data.location.name }
                : null,
            }),
        ...optional('fulfillAt'),
        ...optional('fulfillBy'),
        ...optional('estimatedDeliveryAt'),
        ...optional('method'),
        ...optional('tracking'),
        ...optional('delivery'),
        ...optional('shipping'),
      },
    },
  };
};
