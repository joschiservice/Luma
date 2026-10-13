import {
  json,
  type ProviderRequest,
  type ProviderResponse,
  type ProviderTarget,
} from '@luma/simulator-core';

import type {
  StarshipitContext,
  StarshipitItem,
  StarshipitOrder,
} from './model.js';

/** Names the actual Starshipit operations for fault injection and committed-write accounting. */
export function identify(request: ProviderRequest): ProviderTarget {
  const url = new URL(request.url);
  const write = request.method !== 'GET';
  let bodyId: string | undefined;
  if (write && request.body) {
    try {
      const body: unknown = JSON.parse(request.body);
      if (body && typeof body === 'object' && 'order' in body) {
        const order = body.order;
        if (
          order &&
          typeof order === 'object' &&
          'order_id' in order &&
          (typeof order.order_id === 'string' ||
            typeof order.order_id === 'number')
        )
          bodyId = String(order.order_id);
      }
    } catch {
      // Invalid requests are rejected by the handler and carry no known resource identity.
    }
  }

  return {
    operation: write
      ? 'orders.quantity.update'
      : url.pathname === '/api/track'
        ? 'tracking.read'
        : 'orders.read',
    resource:
      url.searchParams.get('order_id') ??
      url.searchParams.get('order_number') ??
      bodyId,
    write,
  };
}

/** Rejects missing credentials with the provider's unsuccessful response envelope. */
export function unauthorized(): ProviderResponse {
  return json(
    { success: false, errors: [{ message: 'Invalid API credentials' }] },
    401,
  );
}

/** Removes the success envelope to exercise adapter schema validation. */
export function drift(response: ProviderResponse): ProviderResponse {
  return { ...response, body: { incompatible_orders: response.body } };
}

/** Serves the supported orders, full item update and carrier tracking API without live traffic. */
export async function handle(
  context: StarshipitContext,
  request: ProviderRequest,
): Promise<ProviderResponse> {
  if (
    !request.headers['starshipit-api-key'] ||
    !request.headers['ocp-apim-subscription-key']
  )
    return unauthorized();
  const url = new URL(request.url);
  const fail = (message: string, status = 400) =>
    json({ success: false, errors: [{ message }] }, status);
  if (url.pathname === '/api/orders' && request.method === 'GET') {
    const id = url.searchParams.get('order_id');
    const number = url.searchParams.get('order_number');
    if (id || number) {
      const binding = number
        ? await context.store.get<{ id: string }>('order-number', number)
        : undefined;
      const record =
        id || binding
          ? await context.store.get<StarshipitOrder>(
              'order',
              id ?? binding!.data.id,
            )
          : undefined;

      return record
        ? json({ success: true, order: record.data })
        : fail('Order not found', 404);
    }
    const page = Number(url.searchParams.get('page_number') ?? 1);
    const limit = Number(url.searchParams.get('page_size') ?? 100);
    const status = url.searchParams.get('status');
    if (
      !Number.isInteger(page) ||
      page < 1 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 500
    )
      return fail('Invalid pagination');
    if (status && !['Unshipped', 'Printed', 'Shipped'].includes(status))
      return fail('Invalid status');
    const rows = await context.store.page<StarshipitOrder>({
      kind: 'order',
      ...(status ? { key: status } : {}),
      offset: (page - 1) * limit,
      limit,
    });
    const total = await context.store.count({
      kind: 'order',
      ...(status ? { key: status } : {}),
    });

    return json({
      succeeded: true,
      page_number: page,
      page_size: limit,
      total_pages: Math.ceil(total / limit),
      total_records: total,
      data: { orders: rows.items.map((value) => value.data) },
    });
  }
  if (url.pathname === '/api/track' && request.method === 'GET') {
    const number = url.searchParams.get('order_number');
    const binding = number
      ? await context.store.get<{ id: string }>('order-number', number)
      : undefined;
    const order = binding
      ? (await context.store.get<StarshipitOrder>('order', binding.data.id))
          ?.data
      : undefined;
    if (!order) return fail('Order not found', 404);
    const results = order.packages.map((parcel) => ({
      ...parcel,
      order_number: order.order_number,
      order_status: parcel.status,
      carrier_name: parcel.carrier,
      tracking_status: parcel.status,
      tracking_events: parcel.tracking_events.map((event) => ({
        event_datetime: event.event_date,
        status: event.status,
        details: event.description,
      })),
    }));

    return json({
      success: true,
      results: results.length === 1 ? results[0] : results,
    });
  }
  if (url.pathname === '/api/orders' && request.method === 'PUT') {
    let body: { order?: { order_id?: number; items?: StarshipitItem[] } };
    try {
      body = JSON.parse(request.body ?? '{}') as typeof body;
    } catch {
      return fail('Invalid JSON');
    }
    const id = String(body.order?.order_id ?? '');
    const record = await context.store.get<StarshipitOrder>('order', id);
    if (!record) return fail('Order not found', 404);
    if (record.data.status !== 'Unshipped' || record.data.packages.length > 0)
      return fail('Only unshipped orders can be edited');
    const items = body.order?.items;
    if (
      !Array.isArray(items) ||
      items.length !== record.data.items.length ||
      new Set(items.map((item) => item.item_id)).size !== items.length ||
      items.some(
        (item) =>
          !record.data.items.some((value) => value.item_id === item.item_id) ||
          !Number.isInteger(item.quantity) ||
          item.quantity < 0,
      )
    )
      return fail(
        'All original item identities and valid quantities are required',
      );
    const order = {
      ...record.data,
      items: items.map((item) => ({
        ...item,
        ...(item.quantity_to_ship === undefined
          ? {}
          : { quantity_to_ship: item.quantity }),
      })),
      last_updated_date: new Date(context.now).toISOString(),
    };
    await context.store.put('order', id, order, {
      updatedAt: context.now,
      key: order.status,
    });
    context.notify({
      topic: 'order.updated',
      resource: id,
      payload: {
        order_id: order.order_id,
        order_number: order.order_number,
        last_updated_date: order.last_updated_date,
      },
    });

    return { ...json({ success: true, order }), committed: true };
  }

  return fail('Unsupported endpoint', 404);
}
