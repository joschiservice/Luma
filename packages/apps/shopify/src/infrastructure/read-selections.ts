import type { ReadCapability } from '@luma/connections';

const pageInfo = 'pageInfo { hasNextPage endCursor }';
const connection = (field: string, size: number, fields: string, args = '') =>
  `${field}(first: ${size}${args ? `, ${args}` : ''}) { nodes { ${fields} } ${pageInfo} }`;

const bag =
  'shopMoney { amount currencyCode } presentmentMoney { amount currencyCode }';
const order = [
  'id updatedAt createdAt name cancelledAt closed displayFinancialStatus taxesIncluded dutiesIncluded',
  'currencyCode presentmentCurrencyCode tags edited requiresShipping test cancelReason closedAt processedAt sourceName displayFulfillmentStatus',
  ...[
    'currentTotalPriceSet',
    'originalTotalPriceSet',
    'subtotalPriceSet',
    'currentSubtotalPriceSet',
    'totalShippingPriceSet',
    'currentShippingPriceSet',
    'totalDiscountsSet',
    'currentTotalDiscountsSet',
    'totalTaxSet',
    'currentTotalTaxSet',
    'originalTotalDutiesSet',
    'currentTotalDutiesSet',
  ].map((field) => `${field} { ${bag} }`),
  `currentTaxLines { title rate priceSet { ${bag} } }`,
].join(' ');

/** Order line fields, including the line's prices and whether its variant or product still exists. */
export const orderLine = `id quantity currentQuantity name sku lineItemGroup { id title quantity productId variantId variantSku } variantTitle requiresShipping originalUnitPriceSet { ${bag} } discountedUnitPriceAfterAllDiscountsSet { ${bag} } totalDiscountSet { ${bag} } taxLines { rate } variant { inventoryItem { id } } product { id }`;

/** Shipping charges, including those an order edit removed. */
export const shippingLine = `id title code source carrierIdentifier isRemoved originalPriceSet { ${bag} } discountedPriceSet { ${bag} } currentDiscountedPriceSet { ${bag} }`;

/** Discount labels and values; manual discount descriptions are free text and never requested. */
export const discountApplication =
  '__typename index allocationMethod targetType value { ... on MoneyV2 { amount currencyCode } ... on PricingPercentageValue { percentage } } ... on DiscountCodeApplication { code } ... on AutomaticDiscountApplication { title } ... on ManualDiscountApplication { title } ... on ScriptDiscountApplication { title }';

const address = 'address1 address2 city provinceCode zip countryCodeV2';

/**
 * Order fields. The customer reference needs protected customer data access and
 * `read_customers`; addresses need approval for protected address data.
 */
export function orderSelection(customer = false, addresses = false) {
  return [
    order,
    customer ? 'customer { id }' : '',
    addresses
      ? `shippingAddress { ${address} } billingAddress { ${address} }`
      : '',
  ]
    .filter(Boolean)
    .join(' ');
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
 * adds the customer reference to orders and `orderAddresses` their addresses. Orders usually
 * have one shipping charge and few discounts, so those first pages stay small.
 */
export function readSelection(
  capability: ReadCapability,
  orderCustomers = false,
  orderAddresses = false,
): string {
  switch (capability) {
    case 'orders.read':
      return [
        orderSelection(orderCustomers, orderAddresses),
        connection('lineItems', 5, orderLine),
        connection('shippingLines', 1, shippingLine, 'includeRemovals: true'),
        connection('discountApplications', 2, discountApplication),
      ].join(' ');
    case 'products.read':
      return `${product} ${connection('variants', 8, variantSelection)}`;
    case 'inventory.read':
      return `id tracked ${connection('inventoryLevels', 4, level)}`;
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
// about 135 points with its amounts, first five lines, shipping charge and two discounts, so
// seven orders fit.
const rootPageSizes: Partial<Record<ReadCapability, number>> = {
  'orders.read': 7,
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
 * `orderCustomers` adds the customer reference to orders. Export rows of nested connections are
 * matched to their order by the node's ID. Discount applications have no ID, so exports leave
 * them out and those orders' discounts stay unread until an incremental read; shipping lines
 * have IDs and are exported.
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
      return `${orderSelection(orderCustomers, !!access?.address)} ${all('lineItems', orderLine)} ${all('shippingLines(includeRemovals: true)', shippingLine)}`;
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
