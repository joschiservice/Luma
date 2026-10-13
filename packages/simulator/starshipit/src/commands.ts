import type {
  StarshipitContext,
  StarshipitOrder,
  StarshipitPackage,
} from './model.js';

/** Merchant controls; shipments carry exact provider item identities, never SKU guesses. */
export type StarshipitCommand =
  | { kind: 'order'; order: StarshipitOrder }
  | { kind: 'status'; order: string; status: StarshipitOrder['status'] }
  | { kind: 'ship'; order: string; parcel: StarshipitPackage }
  | {
      kind: 'tracking';
      order: string;
      package: number;
      status: string;
      at?: string | undefined;
      tracking_url?: string | undefined;
      carrier?: string | undefined;
    }
  | {
      kind: 'webhook';
      order: string;
      updatedAt?: string | undefined;
      copies?: number | undefined;
    };

/** Updates provider state and queues notifications; missing orders and invalid parcel quantities fail. */
export async function command(
  context: StarshipitContext,
  input: StarshipitCommand,
) {
  const id =
    input.kind === 'order' ? String(input.order.order_id) : input.order;
  const existing = await context.store.get<StarshipitOrder>('order', id);
  const order =
    input.kind === 'order' ? structuredClone(input.order) : existing?.data;
  if (!order) throw new Error('Starshipit order not found');
  if (input.kind === 'order') {
    const number = await context.store.get<{ id: string }>(
      'order-number',
      order.order_number,
    );
    if (number && number.data.id !== id)
      throw new Error('Starshipit order number already exists in this account');
    await context.store.put(
      'order-number',
      order.order_number,
      { id },
      { updatedAt: context.now },
    );
  }
  if (input.kind === 'ship') {
    if (
      !input.parcel.items.length ||
      new Set(input.parcel.items.map((line) => line.item_id)).size !==
        input.parcel.items.length
    )
      throw new Error('Each parcel must name distinct provider items');
    if (
      order.packages.some(
        (parcel) => parcel.package_id === input.parcel.package_id,
      )
    )
      throw new Error('Parcel identity already exists');
    for (const line of input.parcel.items) {
      const item = order.items.find((value) => value.item_id === line.item_id);
      const shipped = order.packages
        .flatMap((parcel) => parcel.items)
        .filter((value) => value.item_id === line.item_id)
        .reduce((sum, value) => sum + value.quantity, 0);
      if (
        !item ||
        !Number.isInteger(line.quantity) ||
        line.quantity < 1 ||
        shipped + line.quantity > item.quantity
      )
        throw new Error('Parcel exceeds remaining provider item quantity');
    }
    order.packages.push(structuredClone(input.parcel));
    for (const item of order.items)
      item.quantity_to_ship =
        item.quantity -
        order.packages
          .flatMap((parcel) => parcel.items)
          .filter((line) => line.item_id === item.item_id)
          .reduce((sum, line) => sum + line.quantity, 0);
    order.status = 'Shipped';
  }
  if (input.kind === 'status') order.status = input.status;
  if (input.kind === 'tracking') {
    const parcel = order.packages.find(
      (value) => value.package_id === input.package,
    );
    if (!parcel) throw new Error('Starshipit parcel not found');
    const at = input.at ?? new Date(context.now).toISOString();
    parcel.status = input.status;
    if (input.tracking_url !== undefined)
      parcel.tracking_url = input.tracking_url;
    if (input.carrier !== undefined) parcel.carrier = input.carrier;
    parcel.last_updated_date = at;
    parcel.tracking_events.push({
      status: input.status,
      description: input.status,
      event_date: at,
    });
  }
  if (input.kind !== 'webhook') {
    order.last_updated_date = new Date(context.now).toISOString();
    await context.store.put('order', id, order, {
      updatedAt: context.now,
      key: order.status,
    });
  }
  const copies = input.kind === 'webhook' ? (input.copies ?? 1) : 1;
  for (let index = 0; index < copies; index++)
    context.notify({
      topic: 'order.updated',
      resource: id,
      payload: {
        order_id: order.order_id,
        order_number: order.order_number,
        last_updated_date:
          input.kind === 'webhook'
            ? (input.updatedAt ?? order.last_updated_date)
            : order.last_updated_date,
      },
    });

  return { id };
}
