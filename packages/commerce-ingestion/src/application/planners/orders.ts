import type { OrderCommercialFacts } from '@luma/connections';

import { normalizers, type Planner } from '../planning.js';

/** Copies the commercial facts an order observation reports; unread groups stay absent. */
function commercialFacts(data: OrderCommercialFacts): OrderCommercialFacts {
  const facts: OrderCommercialFacts = {};
  for (const key of [
    'currencies',
    'amounts',
    'taxesIncluded',
    'dutiesIncluded',
    'taxLines',
    'shippingLines',
    'discounts',
    'tags',
    'attributes',
  ] as const)
    if (data[key] !== undefined) Object.assign(facts, { [key]: data[key] });

  return facts;
}

/** Plans an order once it and every line are mapped; unknown SKUs don't hold it back. */
export const planOrder: Planner<'orders.read'> = async (
  input,
  { lookup, resolve, missing, provenance, digest },
) => {
  const o = input.observation;
  const entityId = await resolve('order', o.source);
  const data = input.observation.data;
  const lines = [];
  for (const line of data.lines) {
    const id = await resolve('order_line', line.id);
    // An unknown SKU does not prevent storing order facts.
    const skuId = line.sku
      ? await lookup({ ...o.source, ...line.sku, resource: 'sku' })
      : null;
    if (id)
      lines.push({
        id,
        skuId,
        ...(line.bundleGroup === undefined
          ? {}
          : { bundleGroup: line.bundleGroup }),
        quantity: line.quantity.amount,
        ...(line.currentQuantity === undefined
          ? {}
          : { currentQuantity: line.currentQuantity?.amount ?? null }),
        cancelledQuantity: line.cancelledQuantity?.amount ?? null,
        unit: line.quantity.unit,
        ...(line.unitPrice === undefined ? {} : { unitPrice: line.unitPrice }),
        ...(line.taxIncluded === undefined
          ? {}
          : { taxIncluded: line.taxIncluded }),
        ...(line.taxRate === undefined ? {} : { taxRate: line.taxRate }),
        ...(line.skuCode === undefined ? {} : { skuCode: line.skuCode }),
        ...(line.title === undefined ? {} : { title: line.title }),
        ...(line.variantTitle === undefined
          ? {}
          : { variantTitle: line.variantTitle }),
        ...(line.prices === undefined ? {} : { prices: line.prices }),
        ...(line.requiresShipping === undefined
          ? {}
          : { requiresShipping: line.requiresShipping }),
        ...(line.catalog === undefined ? {} : { catalog: line.catalog }),
      });
  }
  if (!entityId || missing.length) return { status: 'pending', missing };

  return {
    owner: 'orders',
    snapshot: {
      ...provenance,
      schemaVersion: 7,
      normalizerVersion: normalizers.order,
      entityId,
      kind: 'order',
      mappingVersion: digest(
        JSON.stringify([entityId, lines.map((l) => [l.id, l.skuId])]),
      ),
      data: {
        type: 'order',
        displayNumber: data.displayNumber,
        ...(data.dueAt === undefined ? {} : { dueAt: data.dueAt }),
        ...(data.placedAt === undefined ? {} : { placedAt: data.placedAt }),
        ...(data.total === undefined ? {} : { total: data.total }),
        status: data.status,
        paymentStatus: data.paymentStatus,
        ...commercialFacts(data),
        lines,
      },
    },
  };
};
