import type { StoredRecord } from '@luma/simulator-core';
import { GraphQLError } from 'graphql';

import {
  type Args,
  connection,
  int,
  text,
  valueConnection,
} from './connections.js';
import type { RequestContext } from './context.js';
import {
  beginEdit,
  calculateEdit,
  commitEdit,
  stageQuantity,
} from './order-edits.js';
import { outstanding } from './orders.js';
import {
  gid,
  type OrderData,
  type OrderEditAgreementData,
  type OrderEditSessionData,
  orderMoneyBag,
  parseGid,
  RuleError,
  visibleOrder,
} from './records.js';
import type { TypeResolvers } from './resolvers.js';

type Session = StoredRecord<OrderEditSessionData>;

type Agreement = StoredRecord<OrderEditAgreementData>;

type Calculation = Awaited<ReturnType<typeof calculateEdit>>;

/** Resolves one field of a GraphQL type whose source has a known shape. */
type Resolver<S> = (source: S, args: Args, context: RequestContext) => unknown;

/** Resolvers of one GraphQL type; the schema routes only sources of that shape to them. */
const typed = <S>(map: Record<string, Resolver<S>>) => map as TypeResolvers;

/** Fails the request as Shopify does when the installation lacks `write_order_edits`. */
function requireEditScope(context: RequestContext) {
  if (!context.shop.config.scopes.includes('write_order_edits'))
    throw new GraphQLError('Order edits write scope is required.', {
      extensions: { code: 'ACCESS_DENIED' },
    });
}

/** A Shopify user error payload with every other payload field null. */
const refuse = (fields: string[], field: string, message: string) => ({
  ...Object.fromEntries(fields.map((name) => [name, null])),
  userErrors: [{ field: [field], message }],
});

/** Reports a refused order edit step as Shopify's `userErrors`; other failures propagate. */
function refusal(error: unknown, fields: string[]) {
  if (!(error instanceof RuleError)) throw error;

  return refuse(fields, error.field ?? 'id', error.message);
}

/** Loads a session by its `CalculatedOrder` or `OrderEditSession` global ID. */
async function loadSession(context: RequestContext, id: unknown) {
  const parsed = parseGid(id);
  if (
    !parsed ||
    (parsed.type !== 'CalculatedOrder' && parsed.type !== 'OrderEditSession')
  )
    return undefined;

  return context.shop.store.get<OrderEditSessionData>(
    'OrderEditSession',
    parsed.id,
  );
}

// Calculations per loaded session record, shared by the fields of one calculated order.
const calculations = new WeakMap<Session, Promise<Calculation>>();

/** The calculated order of a session record, computed once per loaded record. */
function calculation(context: RequestContext, session: Session) {
  let pending = calculations.get(session);
  if (!pending) {
    pending = calculateEdit(context.shop, session);
    calculations.set(session, pending);
  }

  return pending;
}

/** The order total change of the staged quantities in minor units. */
const totalChange = ({ lines }: Calculation) =>
  lines.reduce(
    (sum, item) => sum + (item.quantity - item.current) * item.line.data.price,
    0,
  );

/** Shopify's `CalculatedLineItem`; existing lines keep their `LineItem` number. */
const calculatedLine = (item: Calculation['lines'][number]) => ({
  __typename: 'CalculatedLineItem',
  id: gid('CalculatedLineItem', item.line.id),
  quantity: item.quantity,
  editableQuantity: Math.max(
    0,
    item.unfulfilled + item.quantity - item.current,
  ),
  restocking: item.restocking,
});

const sessionFields = ['calculatedOrder', 'orderEditSession'];

const lineFields = ['calculatedLineItem', 'calculatedOrder'];

/**
 * Shopify's calculated-order mutations. Each requires `write_order_edits`. Begin and staging
 * change no order records; only a commit changes the order and marks the request committed.
 */
export const orderEditMutations: TypeResolvers = {
  orderEditBegin: async (_source, args, context) => {
    requireEditScope(context);
    const parsed = parseGid(text(args, 'id'), 'Order');
    const order =
      parsed && (await context.shop.store.get<OrderData>('Order', parsed.id));
    if (!order || !visibleOrder(context.shop, order))
      return refuse(sessionFields, 'id', 'Order does not exist.');
    try {
      const session = await beginEdit(context.shop, order);

      return {
        calculatedOrder: session,
        orderEditSession: session,
        userErrors: [],
      };
    } catch (error) {
      return refusal(error, sessionFields);
    }
  },
  orderEditSetQuantity: async (_source, args, context) => {
    requireEditScope(context);
    const session = await loadSession(context, args.id);
    if (!session)
      return refuse(lineFields, 'id', 'The order edit session does not exist.');
    const line = parseGid(text(args, 'lineItemId'), 'CalculatedLineItem');
    if (!line)
      return refuse(
        lineFields,
        'lineItemId',
        'The calculated line item does not exist.',
      );
    try {
      const staged = await stageQuantity(context.shop, session, {
        lineItem: line.id,
        quantity: int(args, 'quantity') ?? -1,
        restock: args.restock === true,
      });
      const item = (await calculation(context, staged)).lines.find(
        (candidate) => candidate.line.id === line.id,
      );

      return {
        calculatedLineItem: item ? calculatedLine(item) : null,
        calculatedOrder: staged,
        userErrors: [],
      };
    } catch (error) {
      return refusal(error, lineFields);
    }
  },
  orderEditCommit: async (_source, args, context) => {
    requireEditScope(context);
    const session = await loadSession(context, args.id);
    if (!session)
      return refuse(['order'], 'id', 'The order edit session does not exist.');
    try {
      const order = await commitEdit(context.shop, session, {
        staffNote: text(args, 'staffNote'),
        notifyCustomer: args.notifyCustomer === true,
      });
      context.committed = true;
      context.loader.clear();

      return {
        order: await context.shop.store.get('Order', order),
        userErrors: [],
      };
    } catch (error) {
      return refusal(error, ['order']);
    }
  },
};

/**
 * Reads `happened_at:>=VALUE` and `happened_at:>VALUE` terms of an agreement search, with the
 * value optionally quoted; other terms are ignored. Undefined when no term applies.
 */
function happenedFilter(query: string | null) {
  const bounds: ((time: number) => boolean)[] = [];
  for (const match of (query ?? '').matchAll(
    /happened_at:(>=|>)(?:"([^"]*)"|'([^']*)'|(\S+))/g,
  )) {
    const time = Date.parse(match[2] ?? match[3] ?? match[4] ?? '');
    if (Number.isNaN(time)) continue;
    bounds.push(
      match[1] === '>=' ? (value) => value >= time : (value) => value > time,
    );
  }

  return bounds.length
    ? (agreement: Agreement) => {
        const time = Date.parse(agreement.data.happenedAt);

        return bounds.every((bound) => bound(time));
      }
    : undefined;
}

/**
 * Pages an order's order edit agreements, oldest first or newest first with `reverse`, and
 * filters them by a `happened_at` search.
 */
export function orderAgreements(
  context: RequestContext,
  order: StoredRecord<OrderData>,
  args: Args,
) {
  return connection<OrderEditAgreementData>(
    context,
    args,
    { kind: 'OrderEditAgreement', parent: order.id },
    { match: happenedFilter(text(args, 'query')) },
  );
}

/** Field resolvers of the calculated order, agreement and sale types, by GraphQL type. */
export const orderEditResolvers: Record<string, TypeResolvers> = {
  CalculatedOrder: typed<Session>({
    id: (session) => gid('CalculatedOrder', session.id),
    subtotalPriceSet: async (session, _args, context) => {
      const { order, lines } = await calculation(context, session);

      return orderMoneyBag(
        lines.reduce(
          (sum, item) => sum + item.line.data.price * item.quantity,
          0,
        ),
        order.data,
      );
    },
    totalPriceSet: async (session, _args, context) => {
      const calculated = await calculation(context, session);
      const { order } = calculated;

      return orderMoneyBag(
        order.data.total - order.data.refunded + totalChange(calculated),
        order.data,
      );
    },
    totalOutstandingSet: async (session, _args, context) => {
      const calculated = await calculation(context, session);
      const { order } = calculated;

      return orderMoneyBag(
        await outstanding(
          context.shop,
          order.id,
          order.data.total - order.data.refunded + totalChange(calculated),
        ),
        order.data,
      );
    },
    lineItems: async (session, args, context) =>
      valueConnection(
        context,
        args,
        (await calculation(context, session)).lines.map(calculatedLine),
      ),
  }),
  OrderEditAgreement: typed<Agreement>({
    reason: () => 'ORDER_EDIT',
    app: (agreement) =>
      agreement.data.app ? { __typename: 'App', id: agreement.data.app } : null,
    sales: (agreement, args, context) =>
      valueConnection(
        context,
        args,
        agreement.data.sales.map((sale) => ({
          __typename: 'ProductSale',
          id: gid('Sale', sale.id),
          actionType: sale.actionType,
          lineType: 'PRODUCT',
          quantity: sale.quantity,
          lineItemId: sale.lineItem,
        })),
      ),
  }),
  ProductSale: typed<{ lineItemId: string }>({
    lineItem: (sale, _args, context) =>
      context.loader.load('LineItem', sale.lineItemId),
  }),
};
