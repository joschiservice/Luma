import type { ReadCapability } from '@luma/connections';

const pageInfo = 'pageInfo { hasNextPage endCursor }';
const connection = (field: string, size: number, fields: string) =>
  `${field}(first: ${size}) { nodes { ${fields} } ${pageInfo} }`;

const order =
  'id updatedAt createdAt name cancelledAt closed displayFinancialStatus taxesIncluded currentTotalPriceSet { shopMoney { amount currencyCode } }';
const orderLine =
  'id quantity currentQuantity name sku lineItemGroup { id title quantity productId variantId variantSku } originalUnitPriceSet { shopMoney { amount currencyCode } } taxLines { rate } variant { inventoryItem { id } }';

/** Order fields; the customer reference needs protected customer data access and `read_customers`. */
export function orderSelection(customer = false) {
  return customer ? `${order} customer { id }` : order;
}
const product =
  'id updatedAt title status vendor publishedAt priceRangeV2 { minVariantPrice { currencyCode } }';
const variant =
  'id sku title price barcode requiresComponents inventoryItem { id }';

/** The first recipe edge proves an empty recipe cheaply; only overflow needs separate reads. */
export const variantSelection = `${variant} productVariantComponents(first: 1) { nodes { id quantity productVariant { id inventoryItem { id } } } pageInfo { hasNextPage endCursor } }`;
const level =
  'id updatedAt isActive location { id isActive } quantities(names: ["on_hand", "committed", "reserved", "incoming", "damaged", "quality_control", "safety_stock", "available"]) { name quantity }';
const work =
  'id updatedAt status fulfillAt fulfillBy fulfillmentHolds { reason } assignedLocation { name location { id } } deliveryMethod { methodType presentedName }';
const workLine = 'id totalQuantity remainingQuantity lineItem { id }';
const shipment =
  'id updatedAt status deliveredAt inTransitAt displayStatus estimatedDeliveryAt location { id name } trackingInfo(first: 10) { company number url }';
const shipmentLine = 'id quantity lineItem { id }';
const returned =
  'id name status createdAt requestApprovedAt closedAt decline { reason }';
const returnLine =
  'id quantity refundedQuantity returnReasonDefinition { name } ... on ReturnLineItem { fulfillmentLineItem { id lineItem { id } } withCodeDiscountedTotalPriceSet { shopMoney { amount currencyCode } } }';
const reverseLine =
  'id fulfillmentLineItem { id } dispositions { type quantity createdAt }';
const refund =
  'id createdAt updatedAt totalRefundedSet { shopMoney { amount currencyCode } } return { id }';
const refundLine = 'quantity restockType restocked lineItem { id }';
const transaction =
  'id kind status processedAt gateway amountSet { shopMoney { amount currencyCode } }';

/**
 * Nested first pages; overflow is drained before an observation is published. `orderCustomers`
 * adds the customer reference to orders.
 */
export function readSelection(
  capability: ReadCapability,
  orderCustomers = false,
  includeComposition = false,
): string {
  switch (capability) {
    case 'orders.read':
      return `${orderSelection(orderCustomers)} ${connection('lineItems', 8, orderLine)}`;
    case 'products.read':
      return `${product} ${connection('variants', 8, variantSelection)}`;
    case 'inventory.read':
      return `id tracked ${includeComposition ? inventoryCompositionSelection : ''} ${connection('inventoryLevels', 4, level)}`;
    case 'fulfillment.read':
      return `id ${connection('fulfillmentOrders', 3, `${work} ${connection('lineItems', 3, workLine)}`)} fulfillments { ${shipment} ${connection('fulfillmentLineItems', 3, shipmentLine)} }`;
    case 'returns.read':
      return `id ${connection('returns', 2, `${returned} ${connection('returnLineItems', 2, returnLine)} ${connection('reverseFulfillmentOrders', 2, `id status ${connection('lineItems', 2, reverseLine)}`)}`)} refunds { ${refund} ${connection('refundLineItems', 2, refundLine)} ${connection('transactions', 2, transaction)} }`;
    default:
      return 'id';
  }
}

// Largest root pages whose worst-case requested cost stays under Shopify's 1,000-point query
// limit; the simulator contract test reads every capability at these sizes. An order costs
// about 55 points with its first eight lines, so 15 orders fit.
const rootPageSizes: Partial<Record<ReadCapability, number>> = {
  'orders.read': 15,
  'products.read': 15,
  'fulfillment.read': 5,
  'returns.read': 5,
};

/** Bounds a requested root page to the capability's largest page within the query cost limit. */
export function readPageSize(
  capability: ReadCapability,
  requested: number,
): number {
  return Math.min(requested, rootPageSizes[capability] ?? 25);
}

/**
 * Complete export selection for high-volume streams; customer fields follow deployment approval.
 * `orderCustomers` adds the customer reference to orders.
 */
export function bulkReadSelection(
  capability: ReadCapability,
  access?: { contact: boolean; address: boolean },
  orderCustomers = false,
): string {
  const all = (field: string, fields: string) =>
    `${field} { edges { node { ${fields} } } }`;
  switch (capability) {
    case 'orders.read':
      return `${orderSelection(orderCustomers)} ${all('lineItems', orderLine)}`;
    case 'products.read':
      return `${product} ${all('variants', variant)}`;
    case 'inventory.read':
      return `id tracked ${all('inventoryLevels', level)}`;
    case 'customers.read':
      return [
        'id createdAt updatedAt state numberOfOrders amountSpent { amount currencyCode } tags',
        access?.contact
          ? 'displayName defaultEmailAddress { emailAddress } defaultPhoneNumber { phoneNumber }'
          : '',
        access?.address
          ? 'defaultAddress { address1 address2 city province zip countryCodeV2 }'
          : '',
      ].join(' ');
    default:
      throw new Error('This stream does not support bulk history');
  }
}

/** Live first-edge evidence distinguishes a stock-bearing variant from a supported bundle parent. */
export const inventoryCompositionSelection =
  'variant { id requiresComponents productVariantComponents(first: 1) { nodes { id } pageInfo { hasNextPage endCursor } } }';
