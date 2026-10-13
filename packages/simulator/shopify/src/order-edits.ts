import type { StoredRecord } from '@luma/simulator-core';

import {
  openStatuses,
  orderWork,
  touchOrder,
  workLines,
} from './fulfillment.js';
import { adjustLevel, readLevel } from './inventory.js';
import { spend } from './orders.js';
import {
  all,
  type FulfillmentOrderData,
  type FulfillmentOrderLineItemData,
  gid,
  iso,
  type LineItemData,
  load,
  nextId,
  notify,
  type OrderData,
  type OrderEditAgreementData,
  type OrderEditSaleData,
  type OrderEditSessionData,
  parseGid,
  RuleError,
  save,
  type ShopifyContext,
  simulatorAppId,
} from './records.js';
import type { ShopifyCommand, ShopifyCommandResult } from './types.js';

type Session = StoredRecord<OrderEditSessionData>;

/** An order with its lines and open fulfillment work, as an edit validates and changes them. */
interface EditState {
  order: StoredRecord<OrderData>;
  lines: StoredRecord<LineItemData>[];
  work: {
    item: StoredRecord<FulfillmentOrderData>;
    lines: StoredRecord<FulfillmentOrderLineItemData>[];
  }[];
}

/** A validated change of one line's current quantity. */
interface LineEdit {
  line: StoredRecord<LineItemData>;
  quantity: number;
  /** Units added (positive) or removed (negative). */
  delta: number;
}

/** Who made an edit and how Shopify should report it. */
interface EditSource {
  /** App GID of the editing app; null for a staff edit in Shopify admin. */
  app: string | null;
  staffNote: string | null;
  notifyCustomer: boolean;
}

/** A line's current quantity after earlier edits. */
const currentQuantity = (line: LineItemData) =>
  line.currentQuantity ?? line.quantity;

/** Reads an order with its lines and open fulfillment work; fails when the order does not exist. */
async function readEditState(
  context: ShopifyContext,
  order: string,
): Promise<EditState> {
  const record = await load<OrderData>(context, 'Order', order);
  const lines = await all<LineItemData>(context, {
    kind: 'LineItem',
    parent: record.id,
  });
  const work = await Promise.all(
    (await orderWork(context, record.id))
      .filter((item) => openStatuses.includes(item.data.status))
      .map(async (item) => ({
        item,
        lines: await workLines(context, item.id),
      })),
  );

  return { order: record, lines, work };
}

/** Fails when the order is cancelled or closed. */
function assertEditable(order: OrderData) {
  if (order.cancelledAt || order.closed)
    throw new RuleError('The order cannot be edited', 'id');
}

/** Units of an order line still remaining in open fulfillment work. */
const openUnits = (state: EditState, line: string) =>
  state.work.reduce(
    (sum, work) =>
      sum +
      work.lines
        .filter((item) => item.data.lineItem === line)
        .reduce((total, item) => total + item.data.remainingQuantity, 0),
    0,
  );

/** The first open fulfillment work line of an order line, which added units grow. */
function growable(state: EditState, line: string) {
  for (const work of state.work) {
    const item = work.lines.find(
      (candidate) => candidate.data.lineItem === line,
    );
    if (item) return { work: work.item, line: item };
  }

  return undefined;
}

/**
 * Checks a new current quantity of one line against the current records. Removed units must
 * still remain in open fulfillment work, as shipped units cannot be removed. Added units grow
 * the line's open fulfillment work, which must exist at a location that stocks the item.
 */
async function checkLineEdit(
  context: ShopifyContext,
  state: EditState,
  lineItem: string,
  quantity: number,
): Promise<LineEdit> {
  const line = state.lines.find((candidate) => candidate.id === lineItem);
  if (!line)
    throw new RuleError('The line does not belong to this order', 'lineItemId');
  if (!Number.isSafeInteger(quantity) || quantity < 0)
    throw new RuleError(
      'The quantity must be a nonnegative whole number',
      'quantity',
    );
  const delta = quantity - currentQuantity(line.data);
  if (delta < 0 && -delta > openUnits(state, line.id))
    throw new RuleError('Shipped units cannot be removed', 'quantity');
  if (delta > 0) {
    const target = growable(state, line.id);
    if (!target)
      throw new RuleError(
        'Units can be added only to a line with open fulfillment work',
        'quantity',
      );
    if (
      line.data.variant &&
      !(await readLevel(context, line.data.variant, target.work.data.location))
    )
      throw new RuleError(
        'The fulfillment location does not stock this item',
        'quantity',
      );
  }

  return { line, quantity, delta };
}

/** Takes removed units out of open work and releases their committed stock. */
async function removeUnits(
  context: ShopifyContext,
  state: EditState,
  edit: LineEdit,
) {
  let remaining = -edit.delta;
  for (const work of state.work)
    for (const line of work.lines.filter(
      (item) => item.data.lineItem === edit.line.id,
    )) {
      const reduction = Math.min(remaining, line.data.remainingQuantity);
      if (!reduction) continue;
      line.data = {
        ...line.data,
        totalQuantity: line.data.totalQuantity - reduction,
        remainingQuantity: line.data.remainingQuantity - reduction,
      };
      await save(context, 'FulfillmentOrderLineItem', line.id, line.data);
      if (edit.line.data.variant)
        await adjustLevel(
          context,
          edit.line.data.variant,
          work.item.data.location,
          {
            committed: -reduction,
          },
        );
      remaining -= reduction;
    }
}

/** Grows the line's first open work by the added units and commits their stock. */
async function addUnits(
  context: ShopifyContext,
  state: EditState,
  edit: LineEdit,
) {
  const target = growable(state, edit.line.id);
  if (!target) throw new Error('Added units need open fulfillment work');
  target.line.data = {
    ...target.line.data,
    totalQuantity: target.line.data.totalQuantity + edit.delta,
    remainingQuantity: target.line.data.remainingQuantity + edit.delta,
  };
  await save(
    context,
    'FulfillmentOrderLineItem',
    target.line.id,
    target.line.data,
  );
  if (edit.line.data.variant)
    await adjustLevel(
      context,
      edit.line.data.variant,
      target.work.data.location,
      {
        committed: edit.delta,
      },
    );
}

/**
 * Applies validated line edits: changes fulfillment work, committed stock, current line
 * quantities, the order total and customer spend, cancels work left without units, records
 * Shopify's order edit agreement and sends `orders/edited`.
 */
async function applyEdit(
  context: ShopifyContext,
  state: EditState,
  edits: LineEdit[],
  source: EditSource,
) {
  let change = 0;
  for (const edit of edits) {
    if (edit.delta < 0) await removeUnits(context, state, edit);
    else if (edit.delta > 0) await addUnits(context, state, edit);
    await save(context, 'LineItem', edit.line.id, {
      ...edit.line.data,
      currentQuantity: edit.quantity,
    });
    change += edit.delta * edit.line.data.price;
  }
  for (const work of state.work) {
    const empty = work.lines.every((line) => line.data.remainingQuantity === 0);
    await save(context, 'FulfillmentOrder', work.item.id, {
      ...work.item.data,
      ...(empty
        ? { status: 'CANCELLED' as const, holds: [], heldStatus: null }
        : {}),
    });
    if (empty)
      notify(
        context,
        'fulfillment_orders/cancelled',
        'FulfillmentOrder',
        work.item.id,
      );
  }
  const { order } = state;
  await spend(context, order.data.customer, change);
  await touchOrder(context, order, {
    ...order.data,
    total: order.data.total + change,
    edited: true,
  });
  const id = await nextId(context);
  const sales: OrderEditSaleData[] = [];
  for (const edit of edits)
    sales.push({
      id: await nextId(context),
      lineItem: edit.line.id,
      quantity: edit.delta,
      actionType: edit.delta < 0 ? 'RETURN' : 'ORDER',
    });
  await save<OrderEditAgreementData>(
    context,
    'OrderEditAgreement',
    id,
    { order: order.id, happenedAt: iso(context.now), ...source, sales },
    { parent: order.id, created: true },
  );
  const app = source.app ? parseGid(source.app, 'App') : undefined;
  notify(context, 'orders/edited', 'Order', order.id, {
    order_edit: {
      id: Number(id),
      order_id: Number(order.id),
      app_id: app ? Number(app.id) : null,
      notify_customer: source.notifyCustomer,
      staff_note: source.staffNote ?? '',
      line_items: {
        additions: edits
          .filter((edit) => edit.delta > 0)
          .map((edit) => ({ id: Number(edit.line.id), delta: edit.delta })),
        removals: edits
          .filter((edit) => edit.delta < 0)
          .map((edit) => ({ id: Number(edit.line.id), delta: -edit.delta })),
      },
    },
  });
}

/**
 * Reduces or removes unfulfilled units as a staff member in Shopify admin does, without
 * rewriting originally ordered quantities. Validates every line before changing stock, work or
 * totals; shipped units cannot be removed. Records an order edit agreement without an app.
 */
export async function editOrder(
  context: ShopifyContext,
  command: Extract<ShopifyCommand, { kind: 'order-edit' }>,
): Promise<ShopifyCommandResult> {
  const state = await readEditState(context, command.order);
  assertEditable(state.order.data);
  if (
    !command.lines.length ||
    new Set(command.lines.map((line) => line.lineItem)).size !==
      command.lines.length
  )
    throw new RuleError('An edit needs distinct order lines');
  const edits: LineEdit[] = [];
  for (const change of command.lines) {
    const line = state.lines.find(
      (candidate) => candidate.id === change.lineItem,
    );
    if (!line) throw new RuleError('The line does not belong to this order');
    if (
      !Number.isSafeInteger(change.quantity) ||
      change.quantity < 0 ||
      change.quantity >= currentQuantity(line.data)
    )
      throw new RuleError(
        'An edit must reduce the current quantity to a nonnegative whole number',
      );
    edits.push(await checkLineEdit(context, state, line.id, change.quantity));
  }
  await applyEdit(context, state, edits, {
    app: null,
    staffNote: null,
    notifyCustomer: false,
  });

  return {
    id: state.order.id,
    gid: gid('Order', state.order.id),
    name: state.order.data.name,
  };
}

/** Fails unless the session can still stage and commit changes. */
function assertOpen(session: Session) {
  if (session.data.state !== 'open')
    throw new RuleError('The order edit was already committed.', 'id');
}

/**
 * Opens an API order edit session for an editable order. The order does not change and no
 * webhook is sent until the session is committed.
 */
export async function beginEdit(
  context: ShopifyContext,
  order: StoredRecord<OrderData>,
): Promise<Session> {
  assertEditable(order.data);
  const id = await nextId(context);
  await save<OrderEditSessionData>(
    context,
    'OrderEditSession',
    id,
    { order: order.id, state: 'open', changes: [] },
    { parent: order.id, created: true },
  );

  return load<OrderEditSessionData>(context, 'OrderEditSession', id);
}

/**
 * Stages a new current quantity of one order line in an open session after checking it against
 * the current records; the order does not change. Staging the line's current quantity drops
 * its staged change. Fails when the session is committed or the change is not allowed.
 */
export async function stageQuantity(
  context: ShopifyContext,
  session: Session,
  change: { lineItem: string; quantity: number; restock: boolean },
): Promise<Session> {
  assertOpen(session);
  const state = await readEditState(context, session.data.order);
  assertEditable(state.order.data);
  const edit = await checkLineEdit(
    context,
    state,
    change.lineItem,
    change.quantity,
  );
  const changes = session.data.changes.filter(
    (staged) => staged.lineItem !== change.lineItem,
  );
  if (edit.delta)
    changes.push({ ...change, from: currentQuantity(edit.line.data) });
  await save<OrderEditSessionData>(context, 'OrderEditSession', session.id, {
    ...session.data,
    changes,
  });

  return load<OrderEditSessionData>(context, 'OrderEditSession', session.id);
}

/**
 * Commits a session's staged changes as this simulator's app. Every change is checked again
 * against the current records: the order must still be editable, each line must still have the
 * quantity it had when staged, and removed units must still be unfulfilled. Fails without any
 * change when a check fails, the session has no changes or it was already committed.
 */
export async function commitEdit(
  context: ShopifyContext,
  session: Session,
  options: { staffNote: string | null; notifyCustomer: boolean },
) {
  assertOpen(session);
  if (!session.data.changes.length)
    throw new RuleError('The order edit has no changes to commit.');
  const state = await readEditState(context, session.data.order);
  assertEditable(state.order.data);
  const edits: LineEdit[] = [];
  for (const change of session.data.changes) {
    const line = state.lines.find(
      (candidate) => candidate.id === change.lineItem,
    );
    if (line && currentQuantity(line.data) !== change.from)
      throw new RuleError(
        'The order line changed after the edit was calculated.',
      );
    edits.push(
      await checkLineEdit(context, state, change.lineItem, change.quantity),
    );
  }
  await applyEdit(context, state, edits, { app: simulatorAppId, ...options });
  await save<OrderEditSessionData>(context, 'OrderEditSession', session.id, {
    ...session.data,
    state: 'committed',
  });

  return state.order.id;
}

/**
 * An order as an open session would leave it: each line with its current quantity, the staged
 * quantity, the units remaining in open fulfillment work and whether staged removed units are
 * restocked.
 */
export async function calculateEdit(context: ShopifyContext, session: Session) {
  const state = await readEditState(context, session.data.order);

  return {
    order: state.order,
    lines: state.lines.map((line) => {
      const staged = session.data.changes.find(
        (change) => change.lineItem === line.id,
      );
      const current = currentQuantity(line.data);
      const quantity = staged?.quantity ?? current;

      return {
        line,
        current,
        quantity,
        unfulfilled: openUnits(state, line.id),
        restocking: Boolean(staged?.restock && staged.quantity < current),
      };
    }),
  };
}
