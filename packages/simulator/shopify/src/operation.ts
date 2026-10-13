import type { ProviderRequest, ProviderTarget } from '@luma/simulator-core';
import {
  type DocumentNode,
  type FragmentDefinitionNode,
  getNamedType,
  getNullableType,
  getOperationAST,
  GraphQLError,
  type GraphQLNamedType,
  isInterfaceType,
  isLeafType,
  isListType,
  isObjectType,
  Kind,
  type OperationDefinitionNode,
  parse,
  type SelectionSetNode,
  validate,
  type ValueNode,
  visit,
} from 'graphql';

import { schema } from './schema.js';

/** A GraphQL request body as Shopify accepts it. */
export interface GraphQLRequest {
  query: string;
  variables: Record<string, unknown>;
  operationName: string | undefined;
}

/** Reads a GraphQL request body; undefined when it is not a JSON object with a query. */
export function readRequest(
  request: ProviderRequest,
): GraphQLRequest | undefined {
  let body: unknown;
  try {
    body = JSON.parse(request.body ?? '');
  } catch {
    return undefined;
  }
  if (typeof body !== 'object' || body === null) return undefined;
  const query: unknown = Reflect.get(body, 'query');
  const variables: unknown = Reflect.get(body, 'variables');
  const operationName: unknown = Reflect.get(body, 'operationName');
  if (typeof query !== 'string' || !query.trim()) return undefined;

  return {
    query,
    variables:
      typeof variables === 'object' && variables !== null
        ? Object.fromEntries(Object.entries(variables))
        : {},
    operationName:
      typeof operationName === 'string' ? operationName : undefined,
  };
}

interface Prepared {
  document: DocumentNode | undefined;
  errors: readonly GraphQLError[];
}

const prepared = new Map<string, Prepared>();

/** Parses and validates a query against the schema; results are cached by query text. */
export function prepare(query: string): Prepared {
  let entry = prepared.get(query);
  if (!entry) {
    try {
      const document = parse(query);
      entry = { document, errors: validate(schema, document) };
    } catch (error) {
      entry = {
        document: undefined,
        errors: [
          error instanceof GraphQLError
            ? error
            : new GraphQLError(String(error)),
        ],
      };
    }
    // Luma sends a bounded set of query shapes; cap the cache for arbitrary clients.
    if (prepared.size >= 500) prepared.clear();
    prepared.set(query, entry);
  }

  return entry;
}

const mutationCapabilities: Record<string, string> = {
  refundCreate: 'returns.refund',
  returnCreate: 'returns.create',
  returnApproveRequest: 'returns.create',
  returnProcess: 'returns.exchange.process',
  returnCancel: 'returns.exchange.cancel',
  inventorySetQuantities: 'inventory.available.reconcile',
  orderEditBegin: 'orders.quantity.calculate',
  orderEditSetQuantity: 'orders.quantity.calculate',
  orderEditCommit: 'orders.quantity.edit',
  fulfillmentOrderReleaseHold: 'fulfillment.hold.release',
  fulfillmentOrderOpen: 'fulfillment.open',
  fulfillmentOrderMove: 'fulfillment.move',
  fulfillmentCreate: 'fulfillment.shipment.create',
  fulfillmentTrackingInfoUpdate: 'fulfillment.tracking.update',
  webhookSubscriptionCreate: 'connection.verify',
};

const namedCapabilities: Record<string, string> = {
  LumaExchangeChoices: 'returns.exchange.options.read',
  LumaExchangeVariant: 'returns.exchange.quote.read',
  LumaExchangeOrder: 'returns.exchange.proof.read',
  LumaExchangeFinancial: 'returns.exchange.quote.read',
  LumaExchangePayments: 'returns.exchange.proof.read',
  LumaExchangeFulfillment: 'returns.exchange.proof.read',
  LumaExchangeEvenProof: 'returns.exchange.proof.read',
  LumaExchangeRefundProof: 'returns.exchange.proof.read',
  LumaExchangePrice: 'returns.exchange.price.read',
  LumaExchangeReturnable: 'returns.exchange.quote.read',
  LumaExchangeRequest: 'returns.exchange.request',
  LumaExchangeProcess: 'returns.exchange.process',
  LumaExchangeCancel: 'returns.exchange.cancel',
  LumaExchangeRelease: 'returns.exchange.release',
  LumaReturnRefundQuote: 'returns.settlement.quote.read',
  LumaReturnRefundProof: 'returns.settlement.proof.read',
  LumaReturnRefundDetail: 'returns.settlement.proof.read',
  LumaReturnActions: 'returns.created.read',
  LumaReturnable: 'returns.created.read',
  VerifyInstallation: 'connection.verify',
  LumaScopeUpdate: 'connection.verify',
  LumaLifecycleSubscriptions: 'connection.verify',
  LumaCustomerList: 'records.read',
  LumaCustomerOrders: 'records.read',
  LumaInventoryCorrection: 'inventory.available.reconcile',
  LumaFulfillmentRecovery: 'fulfillment.read',
  LumaShipmentPublishingRead: 'fulfillment.read',
  LumaFulfillmentLocations: 'fulfillment.read',
  LumaOrderEditRead: 'orders.quantity.read',
  LumaOrderEditProof: 'orders.quantity.read',
};

/** Read capabilities by the fields and type conditions a query selects, most specific first. */
const readCapabilities: [string, string[]][] = [
  [
    'inventory.transfers.read',
    ['inventoryTransfer', 'inventoryTransfers', 'InventoryTransfer'],
  ],
  [
    'inventory.shipments.read',
    ['inventoryShipment', 'inventoryShipments', 'InventoryShipment'],
  ],
  [
    'returns.read',
    ['returns', 'refunds', 'Return', 'Refund', 'ReverseFulfillmentOrder'],
  ],
  [
    'fulfillment.read',
    ['fulfillmentOrders', 'fulfillments', 'FulfillmentOrder', 'Fulfillment'],
  ],
  ['customers.read', ['customers', 'customersCount', 'Customer']],
  [
    'products.read',
    [
      'products',
      'productsCount',
      'Product',
      'ProductVariant',
      'ProductVariantComponent',
    ],
  ],
  ['inventory.read', ['inventoryItems', 'InventoryItem']],
  ['orders.read', ['orders', 'ordersCount', 'Order', 'LineItemGroup']],
];

/** Classifies an operation as the Luma capability it serves. */
function capability(operation: OperationDefinitionNode) {
  const name = operation.name?.value ?? '';
  if (name === 'LumaExchangeRequest' || name === 'LumaExchangeRelease')
    return namedCapabilities[name] ?? 'unknown';
  if (operation.operation === 'mutation') {
    const [field] = operation.selectionSet.selections;

    return field?.kind === Kind.FIELD
      ? (mutationCapabilities[field.name.value] ?? 'unknown')
      : 'unknown';
  }
  if (name.startsWith('LumaRecord')) return 'records.read';
  const named = namedCapabilities[name];
  if (named) return named;
  const selected = new Set<string>();
  visit(operation, {
    Field: (node) => void selected.add(node.name.value),
    NamedType: (node) => void selected.add(node.name.value),
  });

  return (
    readCapabilities.find(([, names]) =>
      names.some((value) => selected.has(value)),
    )?.[0] ?? 'connection.verify'
  );
}

/**
 * Identifies the Luma capability a request serves from its parsed operation, and the record it
 * addresses: the `id` variable, or the inventory item of a quantity change.
 */
export function identify(request: ProviderRequest): ProviderTarget {
  const body = readRequest(request);
  const document = body && prepare(body.query).document;
  const operation = document && getOperationAST(document, body.operationName);
  if (!body || !operation) return { operation: 'unknown', write: false };
  const input: unknown = body.variables.input;
  const quantities: unknown =
    typeof input === 'object' && input !== null
      ? Reflect.get(input, 'quantities')
      : undefined;
  const first: unknown = Array.isArray(quantities) ? quantities[0] : undefined;
  const item: unknown =
    typeof first === 'object' && first !== null
      ? Reflect.get(first, 'inventoryItemId')
      : undefined;
  const resource =
    typeof body.variables.id === 'string' ? body.variables.id : item;

  return {
    operation: capability(operation),
    ...(typeof resource === 'string' ? { resource } : {}),
    write: operation.operation === 'mutation',
  };
}

/** Reads an integer argument literal or variable. */
function argument(
  node: {
    arguments?:
      readonly { name: { value: string }; value: ValueNode }[] | undefined;
  },
  names: string[],
  variables: Record<string, unknown>,
) {
  for (const name of names) {
    const value = node.arguments?.find(
      (item) => item.name.value === name,
    )?.value;
    if (value?.kind === Kind.INT) return Number(value.value);
    if (value?.kind === Kind.VARIABLE) {
      const resolved = variables[value.name.value];
      if (typeof resolved === 'number') return resolved;
    }
  }

  return undefined;
}

/** Marks requested-cost mode, which multiplies by page sizes rather than returned items. */
const requested = Symbol('requested');

/** Reads a response field by its response key. */
function child(value: unknown, key: string) {
  if (value === requested) return requested;

  return typeof value === 'object' && value !== null
    ? (Reflect.get(value, key) as unknown)
    : undefined;
}

/**
 * Computes Shopify's query cost: each object costs one, a connection two plus the cost of its
 * nodes, leaf fields are free and each mutation costs ten. Inline fragments on different types
 * cost the most expensive branch. The requested cost assumes full pages; the actual cost counts
 * the objects in the response data.
 */
function measure(
  document: DocumentNode,
  operationName: string | undefined,
  variables: Record<string, unknown>,
  data: unknown,
) {
  const operation = getOperationAST(document, operationName);
  if (!operation) return 0;
  if (operation.operation === 'mutation')
    return 10 * operation.selectionSet.selections.length;
  const fragments = new Map(
    document.definitions
      .filter(
        (definition): definition is FragmentDefinitionNode =>
          definition.kind === Kind.FRAGMENT_DEFINITION,
      )
      .map((definition) => [definition.name.value, definition]),
  );

  /** Costs a list of selected objects: per page slot when requested, per item otherwise. */
  function items(
    set: SelectionSetNode | undefined,
    type: GraphQLNamedType,
    value: unknown,
    size: number,
  ) {
    if (value === requested) return size * (1 + cost(set, type, requested));

    return Array.isArray(value)
      ? value.reduce<number>(
          (sum, item) => sum + (item == null ? 0 : 1 + cost(set, type, item)),
          0,
        )
      : 0;
  }

  function cost(
    set: SelectionSetNode | undefined,
    type: GraphQLNamedType | undefined,
    value: unknown,
  ): number {
    if (!set || !type || !(isObjectType(type) || isInterfaceType(type)))
      return 0;
    let total = 0;
    let branches = 0;
    for (const selection of set.selections) {
      if (selection.kind === Kind.FIELD) {
        const field = type.getFields()[selection.name.value];
        if (!field) continue;
        const named = getNamedType(field.type);
        if (isLeafType(named)) continue;
        const result = child(
          value,
          selection.alias?.value ?? selection.name.value,
        );
        if (named.name.endsWith('Connection') && isObjectType(named)) {
          const size = argument(selection, ['first', 'last'], variables) ?? 1;
          total += 2;
          for (const inner of selection.selectionSet?.selections ?? []) {
            const listed =
              inner.kind === Kind.FIELD &&
              ['nodes', 'edges'].includes(inner.name.value)
                ? named.getFields()[inner.name.value]
                : undefined;
            if (inner.kind === Kind.FIELD && listed)
              total += items(
                inner.selectionSet,
                getNamedType(listed.type),
                child(result, inner.alias?.value ?? inner.name.value),
                size,
              );
          }
        } else if (isListType(getNullableType(field.type)))
          total += items(
            selection.selectionSet,
            named,
            result,
            argument(selection, ['first'], variables) ?? 1,
          );
        else if (result != null)
          total += 1 + cost(selection.selectionSet, named, result);
      } else {
        const fragment =
          selection.kind === Kind.FRAGMENT_SPREAD
            ? fragments.get(selection.name.value)
            : selection;
        const condition = fragment?.typeCondition?.name.value;
        const inner = cost(
          fragment?.selectionSet,
          condition ? (schema.getType(condition) ?? undefined) : type,
          value,
        );
        if (condition) branches = Math.max(branches, inner);
        else total += inner;
      }
    }

    return total + branches;
  }

  return cost(
    operation.selectionSet,
    operation.operation === 'subscription'
      ? undefined
      : (schema.getQueryType() ?? undefined),
    data,
  );
}

/** Shopify's requested query cost, which must fit the available budget before execution. */
export const queryCost = (
  document: DocumentNode,
  operationName: string | undefined,
  variables: Record<string, unknown>,
) => measure(document, operationName, variables, requested);

/** Shopify's actual query cost of a response; Shopify refunds the rest of the requested cost. */
export const actualCost = (
  document: DocumentNode,
  operationName: string | undefined,
  variables: Record<string, unknown>,
  data: unknown,
) => measure(document, operationName, variables, data);
