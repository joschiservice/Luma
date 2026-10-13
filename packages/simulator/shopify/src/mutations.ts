import type { StoredRecord } from '@luma/simulator-core';
import {
  getDirectiveValues,
  GraphQLError,
  type GraphQLResolveInfo,
} from 'graphql';

import { type Args, text, texts } from './connections.js';
import type { RequestContext } from './context.js';
import {
  attachExchangeInput,
  cancelExchange,
  processExchange,
  validateExchangeInput,
} from './exchanges.js';
import { moveWork, openWork, releaseHolds, touchOrder } from './fulfillment.js';
import { available, writeLevel } from './inventory.js';
import { orderEditMutations } from './order-edit-api.js';
import {
  all,
  type FulfillmentLineItemData,
  type FulfillmentOrderData,
  gid,
  type IdempotencyKeyData,
  type InventoryItemData,
  type InventoryLevelData,
  levelId,
  location,
  nextId,
  parseGid,
  type ReturnData,
  type ReturnLineItemData,
  RuleError,
  save,
  type WebhookSubscriptionData,
} from './records.js';
import { refundCreate } from './refund-actions.js';
import type { TypeResolvers } from './resolvers.js';
import { approveReturn, requestReturn } from './returns.js';
import { idempotent } from './schema.js';

/** Reads an input object argument as a record of its fields. */
function fields(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? Object.fromEntries(Object.entries(value))
    : {};
}

/** Reasons Shopify accepts for inventory quantity changes. */
const inventoryReasons = new Set([
  'correction',
  'cycle_count_available',
  'damaged',
  'movement_created',
  'movement_updated',
  'movement_received',
  'movement_canceled',
  'other',
  'promotion',
  'quality_control',
  'received',
  'reservation_created',
  'reservation_deleted',
  'reservation_updated',
  'restock',
  'safety_stock',
  'shrinkage',
]);

interface QuantityError {
  field: string[];
  message: string;
  code: string;
}

/**
 * Sets available or on-hand quantities with Shopify's compare-and-set check. Every change is
 * refused when any quantity fails validation or its `changeFromQuantity` is stale. A replay
 * with the same `@idempotent` key and input returns the stored receipt without a new change.
 */
async function setQuantities(
  context: RequestContext,
  args: Args,
  info: GraphQLResolveInfo,
) {
  const [field] = info.fieldNodes;
  const key = field
    ? getDirectiveValues(idempotent, field, info.variableValues)?.key
    : undefined;
  if (typeof key !== 'string' || !key)
    throw new GraphQLError(
      'The @idempotent directive with a key is required for this mutation.',
      { extensions: { code: 'BAD_REQUEST' } },
    );
  const input = fields(args.input);
  const serialized = JSON.stringify(input);
  const { store } = context.shop;
  const receipt = await store.get<IdempotencyKeyData>('IdempotencyKey', key);
  const refuse = (errors: QuantityError[]) => ({
    inventoryAdjustmentGroup: null,
    userErrors: errors,
  });
  if (receipt)
    return receipt.data.input === serialized
      ? receipt.data.result
      : refuse([
          {
            field: ['input'],
            message:
              'The idempotency key was already used with different parameters.',
            code: 'IDEMPOTENCY_KEY_PARAMETER_MISMATCH',
          },
        ]);

  const name = text(input, 'name');
  const reason = text(input, 'reason') ?? '';
  const reference = text(input, 'referenceDocumentUri');
  const errors: QuantityError[] = [];
  if (name !== 'available' && name !== 'on_hand')
    errors.push({
      field: ['input', 'name'],
      message: 'The quantity name must be available or on_hand.',
      code: 'INVALID_NAME',
    });
  if (!inventoryReasons.has(reason))
    errors.push({
      field: ['input', 'reason'],
      message: 'The reason is not a valid inventory change reason.',
      code: 'INVALID_REASON',
    });
  if (reference !== null && !/^[a-z][a-z0-9+.-]*:\S+$/i.test(reference))
    errors.push({
      field: ['input', 'referenceDocumentUri'],
      message: 'The reference document URI is invalid.',
      code: 'INVALID_REFERENCE_DOCUMENT',
    });
  const changes: { level: InventoryLevelData; quantity: number }[] = [];
  const seen = new Set<string>();
  const quantities = Array.isArray(input.quantities) ? input.quantities : [];
  for (const [index, value] of quantities.entries()) {
    const entry = fields(value);
    const at = (name: string) => ['input', 'quantities', String(index), name];
    const target = Number(entry.quantity);
    const item = parseGid(entry.inventoryItemId, 'InventoryItem');
    const place = parseGid(entry.locationId, 'Location');
    const fail = (name: string, code: string, message: string) =>
      errors.push({ field: at(name), code, message });
    if (target < 0)
      fail(
        'quantity',
        'INVALID_QUANTITY_NEGATIVE',
        'The quantity cannot be negative.',
      );
    else if (target > 1_000_000_000)
      fail(
        'quantity',
        'INVALID_QUANTITY_TOO_HIGH',
        'The quantity is too high.',
      );
    if (!('changeFromQuantity' in entry))
      fail(
        'changeFromQuantity',
        'COMPARE_QUANTITY_REQUIRED',
        'A changeFromQuantity is required; pass null to skip the check.',
      );
    const record = item
      ? await store.get<InventoryItemData>('InventoryItem', item.id)
      : undefined;
    if (!item || !record) {
      fail(
        'inventoryItemId',
        'INVALID_INVENTORY_ITEM',
        'The inventory item does not exist.',
      );
      continue;
    }
    if (!place || !location(context.shop, place.id)) {
      fail('locationId', 'INVALID_LOCATION', 'The location does not exist.');
      continue;
    }
    const pair = levelId(item.id, place.id);
    if (seen.has(pair)) {
      fail(
        'inventoryItemId',
        'NO_DUPLICATE_INVENTORY_ITEM_ID_GROUP_ID_PAIR',
        'An inventory item and location pair can appear only once.',
      );
      continue;
    }
    seen.add(pair);
    if (!record.data.tracked) {
      fail(
        'inventoryItemId',
        'NON_MUTABLE_INVENTORY_ITEM',
        'The inventory item is not tracked.',
      );
      continue;
    }
    const level = await store.get<InventoryLevelData>('InventoryLevel', pair);
    if (!level) {
      fail(
        'locationId',
        'ITEM_NOT_STOCKED_AT_LOCATION',
        'The inventory item is not stocked at the location.',
      );
      continue;
    }
    const current =
      name === 'on_hand' ? level.data.onHand : available(level.data);
    const expected = entry.changeFromQuantity;
    if (typeof expected === 'number' && expected !== current)
      fail(
        'changeFromQuantity',
        'CHANGE_FROM_QUANTITY_STALE',
        'The changeFromQuantity no longer matches the persisted quantity.',
      );
    changes.push({ level: level.data, quantity: target });
  }
  if (!quantities.length)
    errors.push({
      field: ['input', 'quantities'],
      message: 'At least one quantity is required.',
      code: 'INVALID_INVENTORY_ITEM',
    });
  if (errors.length) return refuse(errors);

  const applied: {
    inventoryItemId: string;
    locationId: string;
    name: string;
    delta: number;
    quantityAfterChange: number;
  }[] = [];
  for (const { level, quantity } of changes) {
    const before = name === 'on_hand' ? level.onHand : available(level);
    const onHand =
      name === 'on_hand'
        ? quantity
        : quantity +
          level.committed +
          (level.reserved ?? 0) +
          (level.damaged ?? 0) +
          (level.qualityControl ?? 0) +
          (level.safetyStock ?? 0);
    await writeLevel(context.shop, { ...level, onHand });
    applied.push({
      inventoryItemId: gid('InventoryItem', level.item),
      locationId: gid('Location', level.location),
      name: name ?? 'available',
      delta: quantity - before,
      quantityAfterChange: quantity,
    });
  }
  const adjustmentId = await nextId(context.shop);
  await save(
    context.shop,
    'InventoryAdjustmentGroup',
    adjustmentId,
    {
      reason,
      referenceDocumentUri: reference,
      changes: applied,
    },
    { created: true },
  );
  const result = {
    inventoryAdjustmentGroup: await store.get(
      'InventoryAdjustmentGroup',
      adjustmentId,
    ),
    userErrors: [],
  };
  await save<IdempotencyKeyData>(
    context.shop,
    'IdempotencyKey',
    key,
    { input: serialized, result },
    { created: true },
  );
  context.committed = true;
  context.loader.clear();

  return result;
}

/** Loads a fulfillment order for a recovery mutation or reports Shopify's user error. */
async function work(context: RequestContext, id: unknown) {
  const parsed = parseGid(id, 'FulfillmentOrder');

  return parsed
    ? context.shop.store.get<FulfillmentOrderData>(
        'FulfillmentOrder',
        parsed.id,
      )
    : undefined;
}

/**
 * Runs a fulfillment order change and reports refused changes as Shopify's `userErrors`.
 * Successful changes bump the order and return the changed fulfillment order.
 */
async function recover(
  context: RequestContext,
  args: Args,
  resultField: string,
  change: (
    work: StoredRecord<FulfillmentOrderData>,
  ) => Promise<StoredRecord<FulfillmentOrderData>>,
) {
  const current = await work(context, args.id);
  if (!current)
    return {
      [resultField]: null,
      userErrors: [
        { field: ['id'], message: 'Fulfillment order does not exist.' },
      ],
    };
  try {
    const changed = await change(current);
    await touchOrder(context.shop, current.data.order);
    context.committed = true;
    context.loader.clear();

    return { [resultField]: changed, userErrors: [] };
  } catch (error) {
    if (!(error instanceof RuleError)) throw error;

    return {
      [resultField]: null,
      userErrors: [{ field: ['id'], message: error.message }],
    };
  }
}

/** Creates or approves an exact return through the same provider rules as simulator commands. */
async function returnMutation(
  context: RequestContext,
  value: unknown,
  approve: boolean,
) {
  const input = fields(value);
  if (!context.shop.config.scopes.includes('write_returns'))
    throw new GraphQLError('Returns write scope is required.', {
      extensions: { code: 'ACCESS_DENIED' },
    });
  try {
    let id: string;
    if (approve) {
      const target = parseGid(text(input, 'id'), 'Return');
      const current =
        target &&
        (await context.shop.store.get<ReturnData>('Return', target.id));
      if (!current) throw new RuleError('Return not found');
      id = (
        await approveReturn(context.shop, {
          order: current.data.order,
          returnId: current.id,
        })
      ).id;
    } else {
      const exchanges = await validateExchangeInput(context, input);
      const order = parseGid(text(input, 'orderId'), 'Order');
      if (
        !order ||
        !Array.isArray(input.returnLineItems) ||
        !input.returnLineItems.length
      )
        throw new RuleError('Return lines are required');
      const lines = [];
      const notes = new Map<string, string | null>();
      for (const value of input.returnLineItems) {
        const line = fields(value),
          target = parseGid(
            text(line, 'fulfillmentLineItemId'),
            'FulfillmentLineItem',
          );
        const shipped =
          target &&
          (await context.shop.store.get<FulfillmentLineItemData>(
            'FulfillmentLineItem',
            target.id,
          ));
        const quantity = line.quantity;
        if (
          !shipped ||
          !Number.isSafeInteger(quantity) ||
          typeof quantity !== 'number' ||
          quantity < 1
        )
          throw new RuleError('Invalid fulfillment line');
        if (notes.has(shipped.data.lineItem))
          throw new RuleError('Duplicate order line');
        notes.set(shipped.data.lineItem, text(line, 'returnReasonNote'));
        lines.push({ lineItem: shipped.data.lineItem, quantity });
      }
      id = (
        await requestReturn(context.shop, {
          kind: 'return',
          order: order.id,
          lines,
          reason:
            text(fields(input.returnLineItems[0]), 'returnReason') ?? 'OTHER',
        })
      ).id;
      context.committed = true;
      for (const line of await all<ReturnLineItemData>(context.shop, {
        kind: 'ReturnLineItem',
        parent: id,
      }))
        await save(context.shop, 'ReturnLineItem', line.id, {
          ...line.data,
          returnReasonNote: notes.get(line.data.lineItem) ?? null,
        });
      await approveReturn(context.shop, { order: order.id, returnId: id });
      await attachExchangeInput(context, id, exchanges);
    }
    context.committed = true;
    context.loader.clear();

    return {
      return: await context.shop.store.get('Return', id),
      userErrors: [],
    };
  } catch (error) {
    if (error instanceof GraphQLError) throw error;
    if (context.committed) throw error;

    return {
      return: null,
      userErrors: [
        {
          field: ['input'],
          message:
            error instanceof Error
              ? error.message
              : 'Return could not be changed',
        },
      ],
    };
  }
}

/** Shopify Admin API mutations Luma sends. */
export const mutationResolvers: TypeResolvers = {
  ...orderEditMutations,
  refundCreate: (_source, args, context, info) =>
    refundCreate(context, args, info),
  returnCreate: (_source, args, context) =>
    returnMutation(context, args.returnInput, false),
  returnApproveRequest: (_source, args, context) =>
    returnMutation(context, args.input, true),
  returnProcess: (_source, args, context) => processExchange(context, args),
  returnCancel: (_source, args, context) => cancelExchange(context, args),
  inventorySetQuantities: (_source, args, context, info) =>
    setQuantities(context, args, info),
  fulfillmentOrderReleaseHold: (_source, args, context) =>
    recover(context, args, 'fulfillmentOrder', async (current) => {
      const holds = texts(args, 'holdIds')?.map((id) => {
        const hold = parseGid(id, 'FulfillmentHold');
        if (!hold) throw new RuleError('Fulfillment hold not found');

        return hold.id;
      });

      return releaseHolds(context.shop, current, holds);
    }),
  fulfillmentOrderOpen: (_source, args, context) =>
    recover(context, args, 'fulfillmentOrder', (current) =>
      openWork(context.shop, current),
    ),
  fulfillmentOrderMove: (_source, args, context) =>
    recover(context, args, 'movedFulfillmentOrder', (current) => {
      const target = parseGid(text(args, 'newLocationId'), 'Location');
      if (!target || !location(context.shop, target.id))
        throw new RuleError('Location not found');
      if (
        Array.isArray(args.fulfillmentOrderLineItems) &&
        args.fulfillmentOrderLineItems.length
      )
        throw new RuleError(
          'This simulator moves whole fulfillment orders only',
        );

      return moveWork(context.shop, current, target.id);
    }),
  webhookSubscriptionCreate: async (_source, args, context) => {
    const topic = text(args, 'topic') ?? '';
    const input = fields(args.webhookSubscription);
    const uri = text(input, 'uri') ?? '';
    const refuse = (message: string) => ({
      webhookSubscription: null,
      userErrors: [{ field: ['webhookSubscription', 'callbackUrl'], message }],
    });
    try {
      if (!['http:', 'https:'].includes(new URL(uri).protocol))
        return refuse('Address protocol is not supported');
    } catch {
      return refuse('Address is invalid');
    }
    const existing = await context.shop.store.page<WebhookSubscriptionData>({
      kind: 'WebhookSubscription',
      key: topic,
      limit: 250,
    });
    if (existing.items.some((item) => item.data.uri === uri))
      return refuse('Address for this topic has already been taken');
    const id = await nextId(context.shop);
    await save<WebhookSubscriptionData>(
      context.shop,
      'WebhookSubscription',
      id,
      { topic, uri, format: text(input, 'format') ?? 'JSON' },
      { key: topic, created: true },
    );
    context.committed = true;
    context.loader.clear();

    return {
      webhookSubscription: await context.shop.store.get(
        'WebhookSubscription',
        id,
      ),
      userErrors: [],
    };
  },
};
