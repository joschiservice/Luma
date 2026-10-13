import type { StoredRecord } from '@luma/simulator-core';
import {
  GraphQLError,
  type GraphQLFieldResolver,
  type GraphQLResolveInfo,
  type GraphQLTypeResolver,
} from 'graphql';

import {
  type Args,
  argumentError,
  connection,
  count,
  int,
  list,
  text,
  texts,
  valueConnection,
} from './connections.js';
import type { RequestContext } from './context.js';
import { suggestedExchangeFinancial } from './exchanges.js';
import {
  moveOptions,
  supportedActions,
  unfulfilledUnits,
} from './fulfillment.js';
import { available, quantity } from './inventory.js';
import { mutationResolvers } from './mutations.js';
import { orderAgreements, orderEditResolvers } from './order-edit-api.js';
import { outstanding } from './orders.js';
import {
  all,
  type CustomerData,
  decimal,
  type ExchangeLineItemData,
  type FulfillmentData,
  type FulfillmentLineItemData,
  type FulfillmentOrderData,
  type FulfillmentOrderLineItemData,
  gid,
  historyStart,
  type InventoryItemData,
  type InventoryLevelData,
  iso,
  levelGid,
  levelId,
  type LineItemData,
  location,
  locationNode,
  money,
  moneyBag,
  type OrderData,
  orderMoneyBag,
  type OrderTransactionData,
  parseGid,
  type ProductData,
  type ProductVariantData,
  type RefundData,
  type RefundLineItemData,
  type ReturnData,
  type ReturnLineItemData,
  type ReverseFulfillmentOrderLineItemData,
  simulatorAppId,
  visibleOrder,
  type WebhookSubscriptionData,
} from './records.js';
import { suggestedRefund } from './refund-actions.js';
import { matchesText, searchFilter } from './search.js';

/** Resolves one field of a source value. */
type Resolver<S = unknown> = (
  source: S,
  args: Args,
  context: RequestContext,
  info: GraphQLResolveInfo,
) => unknown;

export type TypeResolvers = Record<string, Resolver>;

/** Resolvers of one record type; the schema routes only records of that type to them. */
const on = <D>(map: Record<string, Resolver<StoredRecord<D>>>) =>
  map as TypeResolvers;

/** Record types the `node` field can return; their store kind is the Shopify type name. */
const nodeKinds = new Set([
  'ExchangeLineItem',
  'BasicEvent',
  'Customer',
  'Fulfillment',
  'FulfillmentLineItem',
  'FulfillmentOrder',
  'FulfillmentOrderLineItem',
  'InventoryItem',
  'LineItem',
  'Order',
  'OrderTransaction',
  'Product',
  'ProductVariant',
  'Refund',
  'Return',
  'ReturnLineItem',
  'ReverseFulfillmentOrder',
  'ReverseFulfillmentOrderLineItem',
  'WebhookSubscription',
]);

/** Whether a value is a stored provider record rather than a plain GraphQL object. */
function isRecord(value: unknown): value is StoredRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    'seq' in value &&
    'data' in value
  );
}

/** Shopify sorts by update time only when asked; other sort keys follow creation order. */
const sortOrder = (args: Args) =>
  args.sortKey === 'UPDATED_AT' ? ('updated' as const) : ('created' as const);

/** Loads a record by numeric ID through the request's batching loader. */
const load = <T>(context: RequestContext, kind: string, id: string | null) =>
  id === null ? null : context.loader.load<T>(kind, id);

/** Order search: `name:` matches the order name, free text searches names. */
function orderQuery(context: RequestContext, args: Args, customer?: string) {
  const query = text(args, 'query');
  const filter = searchFilter(query, 'name', (value) =>
    value.startsWith('#') ? value : `#${value}`,
  );
  const start = historyStart(context.shop);

  return {
    query: {
      kind: 'Order',
      parent: customer,
      key: filter.key,
      order: sortOrder(args),
      updatedFrom: filter.updatedFrom,
      updatedBefore: filter.updatedBefore,
      createdFrom:
        start === undefined
          ? filter.createdFrom
          : Math.max(start, filter.createdFrom ?? start),
      createdBefore: filter.createdBefore,
    },
    options: {
      search: query !== null,
      match: filter.text.length
        ? (record: StoredRecord<OrderData>) =>
            matchesText(filter.text, [record.data.name])
        : undefined,
    },
  };
}

/** Customer search: `email:` matches exactly, free text searches name, email and phone. */
function customerQuery(args: Args) {
  const query = text(args, 'query');
  const filter = searchFilter(query, 'email', (value) => value.toLowerCase());

  return {
    query: {
      kind: 'Customer',
      key: filter.key,
      order: sortOrder(args),
      updatedFrom: filter.updatedFrom,
      updatedBefore: filter.updatedBefore,
      createdFrom: filter.createdFrom,
      createdBefore: filter.createdBefore,
    },
    options: {
      search: query !== null,
      match: filter.text.length
        ? (record: StoredRecord<CustomerData>) =>
            matchesText(filter.text, [
              `${record.data.firstName} ${record.data.lastName}`,
              record.data.email,
              record.data.phone,
            ])
        : undefined,
    },
  };
}

/** Product search: free text searches titles. */
function productQuery(args: Args) {
  const query = text(args, 'query');
  const filter = searchFilter(query);

  return {
    query: {
      kind: 'Product',
      order: sortOrder(args),
      updatedFrom: filter.updatedFrom,
      updatedBefore: filter.updatedBefore,
      createdFrom: filter.createdFrom,
      createdBefore: filter.createdBefore,
    },
    options: {
      search: query !== null,
      match: filter.text.length
        ? (record: StoredRecord<ProductData>) =>
            matchesText(filter.text, [record.data.title, record.data.vendor])
        : undefined,
    },
  };
}

/** Resolves a global ID to a record or configured object; null when it does not exist. */
async function node(context: RequestContext, id: string | null) {
  const parsed = parseGid(id);
  if (!parsed) throw argumentError(`Invalid global id '${String(id)}'`);
  if (parsed.type === 'Location') return locationNode(context.shop, parsed.id);
  if (parsed.type === 'InventoryLevel') {
    const item = /[?&]inventory_item_id=([0-9]+)/.exec(parsed.query)?.[1];

    return item
      ? load(context, 'InventoryLevel', levelId(item, parsed.id))
      : null;
  }
  if (!nodeKinds.has(parsed.type)) return null;
  const record = await load(context, parsed.type, parsed.id);
  if (record && parsed.type === 'Order' && !visibleOrder(context.shop, record))
    return null;

  return record ?? null;
}

const root: TypeResolvers = {
  nodes: (_source, args, context) =>
    Promise.all((texts(args, 'ids') ?? []).map((id) => node(context, id))),
  currentAppInstallation: (_source, _args, context) => ({
    __typename: 'AppInstallation',
    id: gid('AppInstallation', '1'),
    app: { __typename: 'App', id: simulatorAppId },
    accessScopes: context.shop.config.scopes.map((handle) => ({ handle })),
  }),
  shop: (_source, _args, context) => ({
    __typename: 'Shop',
    id: gid('Shop', '1'),
    myshopifyDomain: context.shop.config.shop,
  }),
  node: (_source, args, context) => node(context, text(args, 'id')),
  orders: (_source, args, context) => {
    const { query, options } = orderQuery(context, args);

    return connection(context, args, query, options);
  },
  ordersCount: (_source, args, context) => {
    const { query, options } = orderQuery(context, args);

    return count(context, args, query, options);
  },
  customers: (_source, args, context) => {
    const { query, options } = customerQuery(args);

    return connection(context, args, query, options);
  },
  customersCount: (_source, args, context) => {
    const { query, options } = customerQuery(args);

    return count(context, args, query, options);
  },
  products: (_source, args, context) => {
    const { query, options } = productQuery(args);

    return connection(context, args, query, options);
  },
  productsCount: (_source, args, context) => {
    const { query, options } = productQuery(args);

    return count(context, args, query, options);
  },
  inventoryItems: (_source, args, context) => {
    const query = text(args, 'query');
    const filter = searchFilter(query, 'sku');

    return connection(
      context,
      args,
      {
        kind: 'InventoryItem',
        key: filter.key,
        updatedFrom: filter.updatedFrom,
        updatedBefore: filter.updatedBefore,
      },
      { search: query !== null },
    );
  },
  webhookSubscriptions: async (_source, args, context) => {
    const topics = texts(args, 'topics');
    const uri = text(args, 'uri');

    return connection<WebhookSubscriptionData>(
      context,
      args,
      { kind: 'WebhookSubscription' },
      {
        match: (item) =>
          (!topics || topics.includes(item.data.topic)) &&
          (uri === null || item.data.uri === uri),
      },
    );
  },
};

/** Values per request and order, read once per request for the amounts derived from them. */
function perOrder<T>(
  cache: WeakMap<RequestContext, Map<string, Promise<T>>>,
  context: RequestContext,
  order: string,
  read: () => Promise<T>,
) {
  let orders = cache.get(context);
  if (!orders) {
    orders = new Map();
    cache.set(context, orders);
  }
  let value = orders.get(order);
  if (!value) {
    value = read();
    orders.set(order, value);
  }

  return value;
}

const requestLines = new WeakMap<
  RequestContext,
  Map<string, Promise<StoredRecord<LineItemData>[]>>
>();

/** An order's line items, read once per request. */
const orderLines = (context: RequestContext, order: StoredRecord<OrderData>) =>
  perOrder(requestLines, context, order.id, () =>
    all<LineItemData>(context.shop, { kind: 'LineItem', parent: order.id }),
  );

const requestUnfulfilled = new WeakMap<
  RequestContext,
  Map<string, Promise<Map<string, number>>>
>();

/** Units per line of an order still remaining in open fulfillment work, read once per request. */
const orderUnfulfilled = (context: RequestContext, order: string) =>
  perOrder(requestUnfulfilled, context, order, () =>
    unfulfilledUnits(context.shop, order),
  );

/** A line's tax in minor units, rounded per line as Shopify does. */
function lineTax(context: RequestContext, line: LineItemData, units: number) {
  const { taxRate, taxesIncluded } = context.shop.config;
  if (taxRate === undefined) return 0;

  return Math.round(
    (line.price * units * taxRate) / (taxesIncluded ? 1 + taxRate : 1),
  );
}

/** Sums an amount over the order's lines, as placed or as they currently stand. */
async function linesTotal(
  context: RequestContext,
  order: StoredRecord<OrderData>,
  amount: (line: LineItemData, units: number) => number,
  current: boolean,
) {
  return (await orderLines(context, order)).reduce(
    (sum, line) =>
      sum +
      amount(
        line.data,
        current
          ? (line.data.currentQuantity ?? line.data.quantity)
          : line.data.quantity,
      ),
    0,
  );
}

/** The order's shipping charges; older orders have one free charge for their speed. */
const shippingLines = (order: StoredRecord<OrderData>) =>
  order.data.shippingLines ?? [
    {
      id: order.id,
      title: order.data.shipping === 'express' ? 'Express' : 'Standard',
      code: order.data.shipping === 'express' ? 'EXPRESS' : 'STANDARD',
      price: 0,
      removed: false,
    },
  ];

const discount = (line: LineItemData, units: number) =>
  ((line.originalPrice ?? line.price) - line.price) * units;

const subtotal = (line: LineItemData, units: number) => line.price * units;

/** The order's address, or the customer's address for orders stored before addresses. */
async function orderAddress(
  context: RequestContext,
  order: StoredRecord<OrderData>,
  field: 'shippingAddress' | 'billingAddress',
) {
  const customer = await load<CustomerData>(
    context,
    'Customer',
    order.data.customer,
  );
  const address =
    order.data[field] === undefined
      ? (customer?.data.address ?? null)
      : order.data[field];

  return address
    ? {
        __typename: 'MailingAddress',
        address1: address.address1,
        address2: null,
        city: address.city,
        provinceCode: null,
        zip: address.zip,
        countryCodeV2: address.countryCode,
      }
    : null;
}

const orderResolvers = on<OrderData>({
  currencyCode: (order) => order.data.currency,
  presentmentCurrencyCode: (order) =>
    order.data.presentment?.currency ?? order.data.currency,
  dutiesIncluded: () => false,
  edited: (order) => order.data.edited ?? false,
  test: () => false,
  requiresShipping: () => true,
  sourceName: () => 'web',
  tags: (order) => order.data.tags ?? [],
  processedAt: (order) => iso(order.createdAt),
  closedAt: (order) => (order.data.closed ? iso(order.updatedAt) : null),
  shippingAddress: (order, _args, context) =>
    orderAddress(context, order, 'shippingAddress'),
  billingAddress: (order, _args, context) =>
    orderAddress(context, order, 'billingAddress'),
  subtotalPriceSet: async (order, _args, context) =>
    orderMoneyBag(
      await linesTotal(context, order, subtotal, false),
      order.data,
    ),
  currentSubtotalPriceSet: async (order, _args, context) =>
    orderMoneyBag(await linesTotal(context, order, subtotal, true), order.data),
  totalDiscountsSet: async (order, _args, context) =>
    orderMoneyBag(
      await linesTotal(context, order, discount, false),
      order.data,
    ),
  currentTotalDiscountsSet: async (order, _args, context) =>
    orderMoneyBag(await linesTotal(context, order, discount, true), order.data),
  totalTaxSet: async (order, _args, context) =>
    orderMoneyBag(
      await linesTotal(
        context,
        order,
        (line, units) => lineTax(context, line, units),
        false,
      ),
      order.data,
    ),
  currentTotalTaxSet: async (order, _args, context) =>
    orderMoneyBag(
      await linesTotal(
        context,
        order,
        (line, units) => lineTax(context, line, units),
        true,
      ),
      order.data,
    ),
  totalShippingPriceSet: (order) =>
    orderMoneyBag(
      shippingLines(order).reduce((sum, line) => sum + line.price, 0),
      order.data,
    ),
  currentShippingPriceSet: (order) =>
    orderMoneyBag(
      shippingLines(order)
        .filter((line) => !line.removed)
        .reduce((sum, line) => sum + line.price, 0),
      order.data,
    ),
  originalTotalDutiesSet: () => null,
  currentTotalDutiesSet: () => null,
  originalTotalPriceSet: async (order, _args, context) => {
    const added = context.shop.config.taxesIncluded
      ? 0
      : await linesTotal(
          context,
          order,
          (line, units) => lineTax(context, line, units),
          false,
        );

    return orderMoneyBag(
      (await linesTotal(context, order, subtotal, false)) +
        added +
        shippingLines(order).reduce((sum, line) => sum + line.price, 0),
      order.data,
    );
  },
  currentTaxLines: async (order, _args, context) => {
    const { taxRate, taxesIncluded } = context.shop.config;
    if (taxRate === undefined) return [];

    return [
      {
        title: taxesIncluded ? 'VAT' : 'Sales tax',
        rate: taxRate,
        priceSet: orderMoneyBag(
          await linesTotal(
            context,
            order,
            (line, units) => lineTax(context, line, units),
            true,
          ),
          order.data,
        ),
      },
    ];
  },
  shippingLines: (order, args, context) =>
    valueConnection(
      context,
      args,
      shippingLines(order)
        .filter((line) => args.includeRemovals === true || !line.removed)
        .map((line) => ({
          __typename: 'ShippingLine',
          id: gid('ShippingLine', line.id),
          title: line.title,
          code: line.code,
          source: 'shopify',
          carrierIdentifier: null,
          isRemoved: line.removed,
          originalPriceSet: orderMoneyBag(line.price, order.data),
          discountedPriceSet: orderMoneyBag(line.price, order.data),
          currentDiscountedPriceSet: orderMoneyBag(
            line.removed ? 0 : line.price,
            order.data,
          ),
        })),
    ),
  discountApplications: (order, args, context) =>
    valueConnection(
      context,
      args,
      (order.data.discounts ?? []).map((item, index) => ({
        __typename:
          item.kind === 'code'
            ? 'DiscountCodeApplication'
            : 'AutomaticDiscountApplication',
        index,
        ...(item.kind === 'code'
          ? { code: item.label }
          : { title: item.label }),
        allocationMethod: 'ACROSS',
        targetType: 'LINE_ITEM',
        targetSelection: 'ALL',
        value: {
          __typename: 'PricingPercentageValue',
          percentage: item.percentage,
        },
      })),
    ),
  taxesIncluded: (_order, _args, context) =>
    context.shop.config.taxesIncluded ?? false,
  customer: (order, _args, context) =>
    load(context, 'Customer', order.data.customer),
  currentTotalPriceSet: (order) =>
    orderMoneyBag(order.data.total - order.data.refunded, order.data),
  totalOutstandingSet: async (order, _args, context) =>
    moneyBag(
      await outstanding(context.shop, order.id, order.data.total),
      order.data.currency,
    ),
  lineItems: (order, args, context) =>
    connection(context, args, { kind: 'LineItem', parent: order.id }),
  agreements: (order, args, context) => orderAgreements(context, order, args),
  fulfillmentOrders: (order, args, context) =>
    connection(context, args, { kind: 'FulfillmentOrder', parent: order.id }),
  fulfillments: (order, args, context) =>
    list(context, args, { kind: 'Fulfillment', parent: order.id }),
  returns: (order, args, context) =>
    connection(context, args, { kind: 'Return', parent: order.id }),
  suggestedRefund: (order, args, context) =>
    suggestedRefund(context, order, args),
  refunds: (order, args, context) =>
    list(context, args, { kind: 'Refund', parent: order.id }),
  transactions: (order, args, context) =>
    list(context, args, { kind: 'OrderTransaction', parent: order.id }),
  events: (order, args, context) =>
    connection(context, args, { kind: 'BasicEvent', parent: order.id }),
});

const workResolvers = on<FulfillmentOrderData>({
  order: (work, _args, context) => load(context, 'Order', work.data.order),
  assignedLocation: (work, _args, context) => ({
    name:
      location(context.shop, work.data.location)?.name ?? work.data.location,
    location: locationNode(context.shop, work.data.location),
  }),
  deliveryMethod: (work) => ({
    __typename: 'DeliveryMethod',
    id: gid('DeliveryMethod', work.id),
    methodType: 'SHIPPING',
    presentedName: work.data.method.name,
    maxDeliveryDateTime: work.data.method.maxDeliveryAt,
  }),
  fulfillmentHolds: (work) =>
    work.data.holds.map((hold) => ({
      __typename: 'FulfillmentHold',
      id: gid('FulfillmentHold', hold.id),
      reason: hold.reason,
      heldByRequestingApp: hold.heldByRequestingApp,
    })),
  lineItems: (work, args, context) =>
    connection(context, args, {
      kind: 'FulfillmentOrderLineItem',
      parent: work.id,
    }),
  supportedActions: (work, _args, context) =>
    supportedActions(context.shop, work.data).map((action) => ({ action })),
  locationsForMove: async (work, args, context) => {
    const size = int(args, 'first') ?? int(args, 'last');
    if (size === null)
      throw argumentError('You must provide one of first or last.');
    const only = texts(args, 'locationIds');
    const options = (await moveOptions(context.shop, work)).filter(
      (option) => !only || only.includes(gid('Location', option.location)),
    );

    return {
      nodes: options.slice(0, size).map((option) => ({
        location: locationNode(context.shop, option.location),
        movable: option.unavailable === 0,
        unavailableLineItemsCount: {
          count: option.unavailable,
          precision: 'EXACT',
        },
      })),
      pageInfo: { hasNextPage: options.length > size, endCursor: null },
    };
  },
});

/** A line amount in the order's currencies. */
async function lineMoneyBag(
  context: RequestContext,
  line: StoredRecord<LineItemData>,
  value: number,
) {
  const order = await load<OrderData>(context, 'Order', line.data.order);

  return order
    ? orderMoneyBag(value, order.data)
    : moneyBag(value, context.shop.config.currency);
}

/** Field resolvers by GraphQL type; unlisted fields read the record data property of that name. */
const resolvers: Record<string, TypeResolvers> = {
  ...orderEditResolvers,
  QueryRoot: root,
  Mutation: mutationResolvers,
  Order: orderResolvers,
  LineItem: on<LineItemData>({
    currentQuantity: (line) => line.data.currentQuantity ?? line.data.quantity,
    unfulfilledQuantity: async (line, _args, context) =>
      (await orderUnfulfilled(context, line.data.order)).get(line.id) ?? 0,
    discountedTotalSet: (line, _args, context) =>
      moneyBag(
        line.data.price * line.data.quantity,
        context.shop.config.currency,
      ),
    originalUnitPriceSet: async (line, _args, context) =>
      lineMoneyBag(context, line, line.data.originalPrice ?? line.data.price),
    discountedUnitPriceAfterAllDiscountsSet: (line, _args, context) =>
      lineMoneyBag(context, line, line.data.price),
    totalDiscountSet: (line, _args, context) =>
      lineMoneyBag(context, line, discount(line.data, line.data.quantity)),
    variantTitle: (line) => line.data.variantTitle ?? null,
    requiresShipping: () => true,
    product: (line, _args, context) =>
      load(context, 'Product', line.data.product),
    taxLines: (_line, _args, context) =>
      context.shop.config.taxRate === undefined
        ? []
        : [
            {
              rate: context.shop.config.taxRate,
              priceSet: moneyBag(
                Math.round(
                  (_line.data.price *
                    _line.data.quantity *
                    context.shop.config.taxRate) /
                    (context.shop.config.taxesIncluded
                      ? 1 + context.shop.config.taxRate
                      : 1),
                ),
                context.shop.config.currency,
              ),
            },
          ],
    variant: (line, _args, context) =>
      load(context, 'ProductVariant', line.data.variant),
  }),
  ProductVariant: on<ProductVariantData>({
    displayName: async (variant, _args, context) => {
      const product = await load<ProductData>(
        context,
        'Product',
        variant.data.product,
      );

      return `${product?.data.title ?? ''} — ${variant.data.title}`;
    },
    inventoryQuantity: async (variant, _args, context) =>
      (
        await all<InventoryLevelData>(context.shop, {
          kind: 'InventoryLevel',
          parent: variant.id,
        })
      ).reduce((n, level) => n + available(level.data), 0),
    inventoryItem: (variant, _args, context) =>
      load(context, 'InventoryItem', variant.id),
    product: (variant, _args, context) =>
      load(context, 'Product', variant.data.product),
    price: (variant) => money(variant.data.price),
  }),
  Product: on<ProductData>({
    priceRangeV2: (product, _args, context) => ({
      minVariantPrice: {
        amount: decimal(product.data.minPrice),
        currencyCode: context.shop.config.currency,
      },
    }),
    variants: (product, args, context) =>
      connection(context, args, { kind: 'ProductVariant', parent: product.id }),
  }),
  InventoryItem: on<InventoryItemData>({
    variant: (item, _args, context) =>
      load(context, 'ProductVariant', item.data.variant),
    inventoryLevel: (item, args, context) => {
      const place = parseGid(text(args, 'locationId'), 'Location');
      if (!place) throw argumentError('Invalid location ID');

      return load(context, 'InventoryLevel', levelId(item.id, place.id));
    },
    inventoryLevels: (item, args, context) =>
      connection(context, args, { kind: 'InventoryLevel', parent: item.id }),
  }),
  InventoryLevel: on<InventoryLevelData>({
    isActive: (level) => level.data.isActive ?? true,
    id: (level) => levelGid(level.data.item, level.data.location),
    location: (level, _args, context) =>
      locationNode(context.shop, level.data.location),
    quantities: (level, args) =>
      (texts(args, 'names') ?? []).map((name) => {
        const value = quantity(level.data, name);
        if (value === undefined)
          throw new GraphQLError(
            `'${name}' is not a valid inventory quantity name.`,
            {
              extensions: { code: 'BAD_REQUEST' },
            },
          );

        return {
          __typename: 'InventoryQuantity',
          id: `${gid('InventoryQuantity', level.data.location)}?inventory_item_id=${level.data.item}&name=${name}`,
          name,
          quantity: value,
        };
      }),
  }),
  FulfillmentOrder: workResolvers,
  FulfillmentOrderLineItem: on<FulfillmentOrderLineItemData>({
    lineItem: (line, _args, context) =>
      load(context, 'LineItem', line.data.lineItem),
  }),
  Fulfillment: on<FulfillmentData>({
    fulfillmentLineItems: (shipment, args, context) =>
      connection(context, args, {
        kind: 'FulfillmentLineItem',
        parent: shipment.id,
      }),
    location: (shipment, _args, context) =>
      locationNode(context.shop, shipment.data.location),
    trackingInfo: (shipment, args) =>
      shipment.data.tracking.slice(0, int(args, 'first') ?? undefined),
  }),
  FulfillmentLineItem: on<FulfillmentLineItemData>({
    lineItem: (line, _args, context) =>
      load(context, 'LineItem', line.data.lineItem),
  }),
  Return: on<ReturnData>({
    exchangeLineItems: (item, args, context) =>
      connection(context, args, { kind: 'ExchangeLineItem', parent: item.id }),
    refunds: (item, args, context) =>
      connection(
        context,
        args,
        { kind: 'Refund' },
        { match: (refund) => (refund.data as RefundData).return === item.id },
      ),
    suggestedFinancialOutcome: (item, args, context) =>
      suggestedExchangeFinancial(context, item, args),
    order: (item, _args, context) => load(context, 'Order', item.data.order),
    decline: (item) =>
      item.data.declineReason ? { reason: item.data.declineReason } : null,
    returnLineItems: (item, args, context) =>
      connection(context, args, { kind: 'ReturnLineItem', parent: item.id }),
    reverseFulfillmentOrders: (item, args, context) =>
      connection(context, args, {
        kind: 'ReverseFulfillmentOrder',
        parent: item.id,
      }),
  }),
  ReturnLineItem: on<ReturnLineItemData>({
    processedQuantity: (line) => line.data.processedQuantity ?? 0,
    processableQuantity: (line) =>
      line.data.quantity - (line.data.processedQuantity ?? 0),
    returnReasonNote: (line) => line.data.returnReasonNote ?? '',
    fulfillmentLineItem: (line, _args, context) =>
      load(context, 'FulfillmentLineItem', line.data.fulfillmentLineItem),
    withCodeDiscountedTotalPriceSet: (line, _args, context) =>
      moneyBag(line.data.amount, context.shop.config.currency),
    returnReasonDefinition: (line) => ({
      __typename: 'ReturnReasonDefinition',
      id: gid('ReturnReasonDefinition', reasonId(line.data.reason)),
      name: line.data.reason,
    }),
  }),
  ExchangeLineItem: on<ExchangeLineItemData>({
    variantId: (line) => gid('ProductVariant', line.data.variant),
    processableQuantity: (line) =>
      line.data.quantity - line.data.processedQuantity,
    lineItems: async (line, _args, context) =>
      (
        await all<LineItemData>(context.shop, {
          kind: 'LineItem',
          parent: line.data.order,
        })
      ).filter((item) => line.data.lineItems.includes(item.id)),
  }),
  ReverseFulfillmentOrder: on({
    lineItems: (reverse, args, context) =>
      connection(context, args, {
        kind: 'ReverseFulfillmentOrderLineItem',
        parent: reverse.id,
      }),
  }),
  ReverseFulfillmentOrderLineItem: on<ReverseFulfillmentOrderLineItemData>({
    fulfillmentLineItem: (line, _args, context) =>
      load(context, 'FulfillmentLineItem', line.data.fulfillmentLineItem),
    dispositions: (line) =>
      line.data.dispositions.map((disposition) => ({
        __typename: 'ReverseFulfillmentOrderDisposition',
        ...disposition,
        id: gid('ReverseFulfillmentOrderDisposition', disposition.id),
      })),
  }),
  Refund: on<RefundData>({
    note: (refund) => refund.data.note ?? null,
    order: (refund, _args, context) =>
      load(context, 'Order', refund.data.order),
    return: (refund, _args, context) =>
      load(context, 'Return', refund.data.return),
    totalRefundedSet: (refund, _args, context) =>
      moneyBag(refund.data.total, context.shop.config.currency),
    refundLineItems: (refund, args, context) =>
      connection(context, args, { kind: 'RefundLineItem', parent: refund.id }),
    transactions: (refund, args, context) =>
      connection(context, args, {
        kind: 'OrderTransaction',
        parent: refund.data.order,
        key: refund.id,
      }),
  }),
  RefundLineItem: on<RefundLineItemData>({
    lineItem: (line, _args, context) =>
      load(context, 'LineItem', line.data.lineItem),
  }),
  OrderTransaction: on<OrderTransactionData>({
    amountSet: (transaction, _args, context) =>
      moneyBag(transaction.data.amount, context.shop.config.currency),
    parentTransaction: (transaction, _args, context) =>
      load(context, 'OrderTransaction', transaction.data.parent),
  }),
  Customer: on<CustomerData>({
    displayName: (customer) =>
      `${customer.data.firstName} ${customer.data.lastName}`.trim() ||
      customer.data.email,
    numberOfOrders: (customer) => String(customer.data.numberOfOrders),
    amountSpent: (customer, _args, context) => ({
      amount: decimal(customer.data.amountSpent),
      currencyCode: context.shop.config.currency,
    }),
    defaultEmailAddress: (customer) =>
      customer.data.email ? { emailAddress: customer.data.email } : null,
    defaultPhoneNumber: (customer) =>
      customer.data.phone ? { phoneNumber: customer.data.phone } : null,
    defaultAddress: (customer) => ({
      __typename: 'MailingAddress',
      id: gid('MailingAddress', customer.id),
      address1: customer.data.address.address1,
      address2: null,
      city: customer.data.address.city,
      province: null,
      zip: customer.data.address.zip,
      countryCodeV2: customer.data.address.countryCode,
    }),
    orders: (customer, args, context) => {
      const { query, options } = orderQuery(context, args, customer.id);

      return connection(context, args, query, options);
    },
  }),
};

/** A stable ID for a return reason, as Shopify's reason definitions have IDs. */
function reasonId(reason: string) {
  let hash = 2166136261;
  for (const character of reason) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619) >>> 0;
  }

  return String(hash);
}

/**
 * Resolves fields by type. Records expose their global ID and store times; other fields read
 * the record data, or the property of plain objects, of the same name.
 */
export const fieldResolver: GraphQLFieldResolver<unknown, RequestContext> = (
  source,
  args,
  context,
  info,
) => {
  const resolver = resolvers[info.parentType.name]?.[info.fieldName];
  if (resolver) return resolver(source, args, context, info);
  if (isRecord(source)) {
    if (info.fieldName === 'id') return gid(source.kind, source.id);
    if (info.fieldName === 'createdAt') return iso(source.createdAt);
    if (info.fieldName === 'updatedAt') return iso(source.updatedAt);

    return typeof source.data === 'object' && source.data !== null
      ? Reflect.get(source.data, info.fieldName)
      : undefined;
  }

  return typeof source === 'object' && source !== null
    ? Reflect.get(source, info.fieldName)
    : undefined;
};

/** Resolves interface types from the record kind or a plain object's `__typename`. */
export const typeResolver: GraphQLTypeResolver<unknown, RequestContext> = (
  value,
) => {
  if (isRecord(value)) return value.kind;
  if (typeof value === 'object' && value !== null) {
    const name: unknown = Reflect.get(value, '__typename');
    if (typeof name === 'string') return name;
  }

  return undefined;
};
