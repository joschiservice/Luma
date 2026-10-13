import type { StoredRecord } from '@luma/simulator-core';
import { GraphQLError } from 'graphql';

import type { Args } from './connections.js';
import type { RequestContext } from './context.js';
import { workLines } from './fulfillment.js';
import {
  type FulfillmentData,
  type FulfillmentOrderData,
  load,
  parseGid,
  save,
} from './records.js';
import type { TypeResolvers } from './resolvers.js';
import { fulfillOrder } from './shipments.js';

function fields(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? Object.fromEntries(Object.entries(value))
    : {};
}

function tracking(value: unknown) {
  const input = fields(value);
  const numbers = Array.isArray(input.numbers)
    ? input.numbers.map(String)
    : typeof input.number === 'string'
      ? [input.number]
      : [];
  const urls = Array.isArray(input.urls)
    ? input.urls.map(String)
    : typeof input.url === 'string'
      ? [input.url]
      : [];
  const company = typeof input.company === 'string' ? input.company : '';
  if (
    !numbers.length ||
    numbers.length > 20 ||
    new Set(numbers).size !== numbers.length ||
    !company ||
    urls.length !== numbers.length
  )
    throw new Error('Complete tracking information is required');

  return numbers.map((number, index) => ({
    company,
    number,
    url: urls[index]!,
  }));
}

async function response(
  context: RequestContext,
  act: () => Promise<StoredRecord<FulfillmentData>>,
) {
  if (
    !context.shop.config.scopes.some((s) =>
      [
        'write_merchant_managed_fulfillment_orders',
        'write_assigned_fulfillment_orders',
        'write_third_party_fulfillment_orders',
      ].includes(s),
    )
  )
    throw new GraphQLError('Shipment write scope is required.', {
      extensions: { code: 'ACCESS_DENIED' },
    });
  try {
    return { fulfillment: await act(), userErrors: [] };
  } catch (error) {
    if (context.committed) throw error;

    return {
      fulfillment: null,
      userErrors: [
        {
          field: ['fulfillment'],
          message:
            error instanceof Error ? error.message : 'Shipment action rejected',
        },
      ],
    };
  }
}

/** Implements native exact fulfillment and tracking writes; there is no provider replay guarantee. */
export const shipmentMutations: TypeResolvers = {
  fulfillmentCreate: (_source, args: Args, context: RequestContext) =>
    response(context, async () => {
      const input = fields(args.fulfillment),
        groups = Array.isArray(input.lineItemsByFulfillmentOrder)
          ? input.lineItemsByFulfillmentOrder.map(fields)
          : [];
      const parcel = tracking(input.trackingInfo);
      if (!groups.length)
        throw new Error('Exact fulfillment-order allocations are required');
      const works: StoredRecord<FulfillmentOrderData>[] = [];
      const lines: { lineItem: string; quantity: number }[] = [];
      const seen = new Set<string>();
      const allocations: {
        fulfillmentOrderId: string;
        lineId: string;
        quantity: number;
      }[] = [];
      for (const group of groups) {
        const id = parseGid(
          String(group.fulfillmentOrderId),
          'FulfillmentOrder',
        )?.id;
        if (!id) throw new Error('Invalid fulfillment-order identity');
        const work = await load<FulfillmentOrderData>(
          context.shop,
          'FulfillmentOrder',
          id,
        );
        if (
          !['OPEN', 'IN_PROGRESS'].includes(work.data.status) ||
          work.data.requestStatus !== 'UNSUBMITTED'
        )
          throw new Error('Fulfillment order is not eligible');
        if (works.some((w) => w.id === id))
          throw new Error('Duplicate fulfillment order');
        works.push(work);
        const exact = Array.isArray(group.fulfillmentOrderLineItems)
          ? group.fulfillmentOrderLineItems.map(fields)
          : [];
        if (!exact.length)
          throw new Error('Exact line allocations are required');
        const available = await workLines(context.shop, id);
        for (const a of exact) {
          const lineId = parseGid(String(a.id), 'FulfillmentOrderLineItem')?.id,
            line = available.find((l) => l.id === lineId),
            quantity = Number(a.quantity);
          if (
            !line ||
            !Number.isSafeInteger(quantity) ||
            quantity < 1 ||
            quantity > line.data.remainingQuantity ||
            seen.has(line.id)
          )
            throw new Error('Line allocation changed');
          allocations.push({
            fulfillmentOrderId: work.id,
            lineId: line.id,
            quantity,
          });
          seen.add(line.id);
          lines.push({ lineItem: line.data.lineItem, quantity });
        }
      }
      const first = works[0]!;
      if (
        works.some(
          (w) =>
            w.data.order !== first.data.order ||
            w.data.location !== first.data.location,
        )
      )
        throw new Error('Fulfillment orders must share order and location');
      context.committed = true;
      context.loader.clear();
      const result = await fulfillOrder(
        context.shop,
        {
          kind: 'fulfill',
          order: first.data.order,
          lines,
          carrier: parcel[0]!.company,
          trackingNumber: parcel[0]!.number,
          trackingUrl: parcel[0]!.url,
        },
        allocations,
      );
      const id = result.id;
      const shipment = await load<FulfillmentData>(
        context.shop,
        'Fulfillment',
        id,
      );
      shipment.data = { ...shipment.data, tracking: parcel };
      await save(context.shop, 'Fulfillment', id, shipment.data);

      return shipment;
    }),
  fulfillmentTrackingInfoUpdate: (
    _source,
    args: Args,
    context: RequestContext,
  ) =>
    response(context, async () => {
      const id = parseGid(String(args.fulfillmentId), 'Fulfillment')?.id;
      if (!id) throw new Error('Invalid fulfillment identity');
      const shipment = await load<FulfillmentData>(
        context.shop,
        'Fulfillment',
        id,
      );
      if (shipment.data.status !== 'SUCCESS')
        throw new Error('Shipment is cancelled or failed');
      const parcel = tracking(args.trackingInfoInput);
      context.committed = true;
      context.loader.clear();
      shipment.data = { ...shipment.data, tracking: parcel };
      await save(context.shop, 'Fulfillment', id, shipment.data);

      return shipment;
    }),
};
