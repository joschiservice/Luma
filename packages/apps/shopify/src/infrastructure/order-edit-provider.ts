import { createHash, randomUUID } from 'node:crypto';

import {
  type CapabilityHandler,
  type CapabilityInput,
  ConnectorError,
} from '@luma/connections';
import {
  createClient,
  parse,
  type ShopifyTransportOptions,
} from '@luma/connector-shopify';
import { canonicalJson } from '@luma/platform';
import { z } from 'zod';

import {
  type EditAgreement,
  type EditProof,
  maxEditedLines,
  type OrderEditCalculation,
  orderEditMarker,
  type OrderEditSnapshot,
} from '../domain/order-edits.js';

const id = (kind: string) =>
  z.string().regex(new RegExp(`^gid://shopify/${kind}/[0-9]+$`));

const moneyFields =
  'fragment LumaMoney on MoneyBag { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }';

const moneyBag = z
  .object({
    shopMoney: z.object({
      amount: z.string(),
      currencyCode: z.string(),
    }),
    presentmentMoney: z.object({
      amount: z.string(),
      currencyCode: z.string(),
    }),
  })
  .transform((value) => ({
    shop: value.shopMoney,
    presentment: value.presentmentMoney,
  }));

const pageInfo = z.object({ hasNextPage: z.boolean() });

const userErrors = z.array(
  z.object({ field: z.array(z.string()).nullable(), message: z.string() }),
);

/** Order lines, totals and fulfillment work in one read; the cost stays well under Shopify's limit. */
const readQuery = `query LumaOrderEditRead($id: ID!) { node(id: $id) { ... on Order { id updatedAt cancelledAt closed currencyCode presentmentCurrencyCode currentSubtotalPriceSet { ...LumaMoney } currentTotalPriceSet { ...LumaMoney } totalOutstandingSet { ...LumaMoney } lineItems(first: 100) { nodes { id name sku quantity currentQuantity unfulfilledQuantity } pageInfo { hasNextPage } } fulfillmentOrders(first: 5) { nodes { id status requestStatus lineItems(first: 50) { nodes { lineItem { id } remainingQuantity totalQuantity } pageInfo { hasNextPage } } } pageInfo { hasNextPage } } } } } ${moneyFields}`;

const readSchema = z.object({
  id: id('Order'),
  updatedAt: z.string().datetime(),
  cancelledAt: z.string().nullable(),
  closed: z.boolean(),
  currentSubtotalPriceSet: moneyBag,
  currentTotalPriceSet: moneyBag,
  totalOutstandingSet: moneyBag,
  lineItems: z.object({
    nodes: z.array(
      z.object({
        id: id('LineItem'),
        name: z.string(),
        sku: z.string().nullable(),
        quantity: z.number().int().nonnegative(),
        currentQuantity: z.number().int().nonnegative(),
        unfulfilledQuantity: z.number().int().nonnegative(),
      }),
    ),
    pageInfo,
  }),
  fulfillmentOrders: z.object({
    nodes: z.array(
      z.object({
        id: id('FulfillmentOrder'),
        status: z.string(),
        requestStatus: z.string(),
        lineItems: z.object({
          nodes: z.array(
            z.object({
              lineItem: z.object({ id: id('LineItem') }),
              remainingQuantity: z.number().int().nonnegative(),
              totalQuantity: z.number().int().nonnegative(),
            }),
          ),
          pageInfo,
        }),
      }),
    ),
    pageInfo,
  }),
});

const proofQuery =
  'query LumaOrderEditProof($id: ID!, $query: String) { currentAppInstallation { app { id } } node(id: $id) { ... on Order { id updatedAt cancelledAt lineItems(first: 100) { nodes { id currentQuantity } pageInfo { hasNextPage } } agreements(first: 5, reverse: true, query: $query) { nodes { __typename id happenedAt reason app { id } sales(first: 25) { nodes { __typename actionType lineType quantity ... on ProductSale { lineItem { id } } } pageInfo { hasNextPage } } } pageInfo { hasNextPage } } } } }';

const proofSchema = z.object({
  currentAppInstallation: z.object({ app: z.object({ id: z.string() }) }),
  node: z.object({
    id: id('Order'),
    cancelledAt: z.string().nullable(),
    lineItems: z.object({
      nodes: z.array(
        z.object({
          id: id('LineItem'),
          currentQuantity: z.number().int().nonnegative(),
        }),
      ),
      pageInfo,
    }),
    agreements: z.object({
      nodes: z.array(
        z.object({
          __typename: z.string(),
          id: z.string(),
          happenedAt: z.string().datetime(),
          reason: z.string(),
          app: z.object({ id: z.string() }).nullable(),
          sales: z.object({
            nodes: z.array(
              z.object({
                __typename: z.string(),
                actionType: z.string(),
                lineType: z.string(),
                quantity: z.number().int().nullable(),
                lineItem: z.object({ id: id('LineItem') }).optional(),
              }),
            ),
            pageInfo,
          }),
        }),
      ),
      pageInfo,
    }),
  }),
});

const calculatedOrder = z.object({
  id: id('CalculatedOrder'),
  subtotalPriceSet: moneyBag.nullable(),
  totalPriceSet: moneyBag,
  totalOutstandingSet: moneyBag,
  lineItems: z.object({
    nodes: z.array(
      z.object({
        id: id('CalculatedLineItem'),
        quantity: z.number().int().nonnegative(),
      }),
    ),
    pageInfo,
  }),
});

const tail = (gid: string) => gid.split('/').at(-1)!;

/** Shopify numbers an existing line's calculated line like the line itself. */
const calculatedLine = (lineItemId: string) =>
  `gid://shopify/CalculatedLineItem/${tail(lineItemId)}`;

/**
 * Stable digest of a calculation's quantities and money, bound into the approved action. Keys are
 * canonicalized, so a calculation read back from storage digests the same.
 */
export function calculationDigest(calculation: OrderEditCalculation) {
  return createHash('sha256')
    .update(
      canonicalJson({
        subtotal: calculation.subtotal,
        total: calculation.total,
        outstanding: calculation.outstanding,
        lines: [...calculation.lines].sort((a, b) =>
          a.lineItemId.localeCompare(b.lineItemId),
        ),
      }),
    )
    .digest('hex');
}

export interface OrderEditEvidence {
  id: string;
  kind: 'observation' | 'calculation' | 'acceptance';
  observedAt: string;
  document: unknown;
}

/** The persistent one-shot fence around Luma's single commit for an operation. */
export interface OrderEditFencePort {
  /** Reserves the operation before any calculation; false when it was reserved or closed before. */
  reserve(operationId: string): Promise<boolean>;
  /** Marks the commit as sent; false when reconciliation closed the operation first. */
  send(operationId: string): Promise<boolean>;
  /** Records a definitive outcome of a reserved or sent operation. */
  finish(
    operationId: string,
    state: 'accepted' | 'withheld' | 'rejected',
  ): Promise<void>;
}

const withheld = () =>
  new ConnectorError({
    code: 'conflict',
    effect: 'none',
    retry: 'never',
    dispatch: 'not_dispatched',
  });

/**
 * Reads Shopify orders for quantity edits, calculates staged edits without committing them, and
 * commits one approved edit at most once per operation behind a durable fence.
 */
export function createOrderEditProvider(
  options: ShopifyTransportOptions & {
    tenantId: string;
    connectionId: string;
    record(evidence: OrderEditEvidence): Promise<void>;
    fence: OrderEditFencePort;
    /** Rechecks the operation's eligibility, authority and grants on the final read before calculating. */
    eligible(
      operationId: string,
      snapshot: OrderEditSnapshot,
    ): Promise<boolean>;
    now?: () => Date;
  },
) {
  const request = createClient(options);
  const now = options.now ?? (() => new Date());

  async function read(orderId: string): Promise<OrderEditSnapshot> {
    id('Order').parse(orderId);
    const observedAt = now().toISOString();
    const data = await request(readQuery, { id: orderId });
    if (data.node === null)
      throw new ConnectorError({
        code: 'not_found',
        effect: 'none',
        retry: 'never',
      });
    const value = parse(readSchema, data.node);
    if (value.id !== orderId)
      throw new ConnectorError({
        code: 'not_found',
        effect: 'none',
        retry: 'never',
      });
    const snapshot: OrderEditSnapshot = {
      id: randomUUID(),
      observedAt,
      revision: createHash('sha256')
        .update(JSON.stringify(value))
        .digest('hex'),
      updatedAt: value.updatedAt,
      orderId,
      cancelled: value.cancelledAt !== null,
      closed: value.closed,
      totals: {
        subtotal: value.currentSubtotalPriceSet,
        total: value.currentTotalPriceSet,
        outstanding: value.totalOutstandingSet,
      },
      lines: value.lineItems.nodes,
      fulfillmentOrders: value.fulfillmentOrders.nodes.map((work) => ({
        id: work.id,
        status: work.status,
        requestStatus: work.requestStatus,
        lines: work.lineItems.nodes.map((line) => ({
          lineItemId: line.lineItem.id,
          remaining: line.remainingQuantity,
          total: line.totalQuantity,
        })),
      })),
      complete:
        !value.lineItems.pageInfo.hasNextPage &&
        !value.fulfillmentOrders.pageInfo.hasNextPage &&
        value.fulfillmentOrders.nodes.every(
          (work) => !work.lineItems.pageInfo.hasNextPage,
        ),
    };
    await options.record({
      id: snapshot.id,
      kind: 'observation',
      observedAt,
      document: snapshot,
    });

    return snapshot;
  }

  /**
   * Stages the quantities in a new Shopify edit session and returns Shopify's calculation. The
   * session is never committed here; an abandoned session changes nothing. Refusals throw a
   * `conflict` without effect.
   */
  async function calculate(
    orderId: string,
    lines: { lineItemId: string; quantity: number; currentQuantity: number }[],
    restock: boolean,
  ): Promise<{ calculation: OrderEditCalculation; sessionId: string }> {
    if (!lines.length || lines.length > maxEditedLines)
      throw new ConnectorError({
        code: 'invalid_input',
        effect: 'none',
        retry: 'never',
      });
    const begun = parse(
      z.object({
        calculatedOrder: z.object({ id: id('CalculatedOrder') }).nullable(),
        userErrors,
      }),
      (
        await request(
          'mutation LumaOrderEditBegin($id: ID!) { result: orderEditBegin(id: $id) { calculatedOrder { id } userErrors { field message } } }',
          { id: orderId },
        )
      ).result,
    );
    if (begun.userErrors.length || !begun.calculatedOrder) throw withheld();
    const sessionId = begun.calculatedOrder.id;
    let calculated: z.infer<typeof calculatedOrder> | null = null;
    for (const line of lines) {
      const staged = parse(
        z.object({ calculatedOrder: calculatedOrder.nullable(), userErrors }),
        (
          await request(
            `mutation LumaOrderEditSetQuantity($id: ID!, $lineItemId: ID!, $quantity: Int!, $restock: Boolean) { result: orderEditSetQuantity(id: $id, lineItemId: $lineItemId, quantity: $quantity, restock: $restock) { calculatedOrder { id subtotalPriceSet { ...LumaMoney } totalPriceSet { ...LumaMoney } totalOutstandingSet { ...LumaMoney } lineItems(first: 100) { nodes { id quantity } pageInfo { hasNextPage } } } userErrors { field message } } } ${moneyFields}`,
            {
              id: sessionId,
              lineItemId: calculatedLine(line.lineItemId),
              quantity: line.quantity,
              // Restocking only applies to removed units.
              restock: restock && line.quantity < line.currentQuantity,
            },
          )
        ).result,
      );
      if (
        staged.userErrors.length ||
        !staged.calculatedOrder ||
        staged.calculatedOrder.id !== sessionId
      )
        throw withheld();
      calculated = staged.calculatedOrder;
    }
    if (!calculated || calculated.lineItems.pageInfo.hasNextPage)
      throw withheld();
    const calculation: OrderEditCalculation = {
      id: randomUUID(),
      observedAt: now().toISOString(),
      subtotal: calculated.subtotalPriceSet,
      total: calculated.totalPriceSet,
      outstanding: calculated.totalOutstandingSet,
      lines: calculated.lineItems.nodes.map((line) => ({
        lineItemId: `gid://shopify/LineItem/${tail(line.id)}`,
        quantity: line.quantity,
      })),
    };
    for (const line of lines)
      if (
        calculation.lines.find((item) => item.lineItemId === line.lineItemId)
          ?.quantity !== line.quantity
      )
        throw withheld();
    await options.record({
      id: calculation.id,
      kind: 'calculation',
      observedAt: calculation.observedAt,
      document: calculation,
    });

    return { calculation, sessionId };
  }

  /**
   * Reads Luma's app identity, the order's current line quantities and its recent edit
   * agreements since `since`. Proof never writes to Shopify.
   */
  async function proof(orderId: string, since: string): Promise<EditProof> {
    id('Order').parse(orderId);
    const observedAt = now().toISOString();
    const data = parse(
      proofSchema,
      await request(proofQuery, {
        id: orderId,
        query: `happened_at:>='${new Date(Date.parse(since) - 10 * 60_000).toISOString()}'`,
      }),
    );
    if (data.node.id !== orderId)
      throw new ConnectorError({
        code: 'not_found',
        effect: 'none',
        retry: 'never',
      });
    const agreements: EditAgreement[] = data.node.agreements.nodes.map(
      (agreement) => {
        const deltas: Record<string, number> = {};
        let complete = !agreement.sales.pageInfo.hasNextPage;
        for (const sale of agreement.sales.nodes) {
          if (sale.lineType !== 'PRODUCT' || sale.actionType === 'UPDATE')
            continue;
          if (
            !sale.lineItem ||
            sale.quantity === null ||
            !['ORDER', 'RETURN'].includes(sale.actionType)
          ) {
            complete = false;
            continue;
          }
          // Shopify's sign convention for returned units is not documented; the action decides it.
          const units = Math.abs(sale.quantity);
          deltas[sale.lineItem.id] =
            (deltas[sale.lineItem.id] ?? 0) +
            (sale.actionType === 'RETURN' ? -units : units);
        }

        return {
          id: agreement.id,
          reason: agreement.reason,
          happenedAt: agreement.happenedAt,
          appId: agreement.app?.id ?? null,
          deltas,
          complete,
        };
      },
    );
    const evidence: EditProof = {
      observedAt,
      appId: data.currentAppInstallation.app.id,
      agreements,
      complete:
        !data.node.lineItems.pageInfo.hasNextPage &&
        !data.node.agreements.pageInfo.hasNextPage,
      cancelled: data.node.cancelledAt !== null,
      lines: data.node.lineItems.nodes,
    };
    await options.record({
      id: randomUUID(),
      kind: 'observation',
      observedAt,
      document: evidence,
    });

    return evidence;
  }

  const handler: CapabilityHandler<'orders.quantity.edit'> = {
    descriptor: {
      version: '0',
      minimumRisk: 'medium',
      permission: 'shopify:order_edits.apply',
      idempotency: 'none',
      retry: { maxAttempts: 1, initialDelayMs: 0 },
    },
    parseInput: (input) =>
      z
        .object({
          operationId: z.string().uuid(),
          orderId: id('Order'),
          expectedRevision: z.string().min(1).max(100),
          restock: z.boolean(),
          lines: z
            .array(
              z
                .object({
                  lineItemId: id('LineItem'),
                  currentQuantity: z.number().int().nonnegative(),
                  quantity: z.number().int().nonnegative(),
                })
                .strict(),
            )
            .min(1)
            .max(maxEditedLines),
          calculationDigest: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .nullable(),
        })
        .strict()
        .parse(input),
    parseOutput: (value) =>
      z
        .object({
          status: z.literal('accepted'),
          evidenceRefs: z.array(z.string().uuid()).min(1),
          providerRequestId: z.string().nullable(),
        })
        .strict()
        .parse(value),
    async run(context, input: CapabilityInput<'orders.quantity.edit'>) {
      if (
        context.tenant.tenantId !== options.tenantId ||
        context.connectionId !== options.connectionId ||
        context.provider !== 'shopify' ||
        !context.idempotencyKey
      )
        throw new ConnectorError({
          code: 'permission_denied',
          effect: 'none',
          retry: 'never',
        });
      // A reserved operation never reaches Shopify twice. Its fence state, not this call,
      // then decides the outcome during reconciliation.
      if (!(await options.fence.reserve(input.operationId)))
        throw new ConnectorError({
          code: 'conflict',
          effect: 'unknown',
          retry: 'reconcile',
          dispatch: 'uncertain',
        });
      let commitSent = false;
      try {
        const current = await read(input.orderId);
        if (
          !input.calculationDigest ||
          current.revision !== input.expectedRevision ||
          input.lines.some(
            (line) =>
              current.lines.find((item) => item.id === line.lineItemId)
                ?.currentQuantity !== line.currentQuantity,
          ) ||
          !(await options.eligible(input.operationId, current))
        )
          throw withheld();
        const { calculation, sessionId } = await calculate(
          input.orderId,
          input.lines,
          input.restock,
        );
        if (calculationDigest(calculation) !== input.calculationDigest)
          throw withheld();
        if (!(await options.fence.send(input.operationId))) throw withheld();
        commitSent = true;
        const result = parse(
          z.object({
            order: z
              .object({ id: id('Order'), updatedAt: z.string() })
              .nullable(),
            userErrors,
          }),
          (
            await request(
              'mutation LumaOrderEditCommit($id: ID!, $staffNote: String) { result: orderEditCommit(id: $id, notifyCustomer: false, staffNote: $staffNote) { order { id updatedAt } userErrors { field message } } }',
              {
                id: sessionId,
                staffNote: orderEditMarker(input.operationId),
              },
            )
          ).result,
        );
        if (result.userErrors.length && result.order)
          throw new Error('Commit returned an ambiguous receipt');
        if (result.userErrors.length) {
          await options.fence.finish(input.operationId, 'rejected');
          throw withheld();
        }
        if (result.order?.id !== input.orderId)
          throw new Error('Invalid commit receipt');
        await options.fence.finish(input.operationId, 'accepted');
        const evidenceId = randomUUID();
        await options.record({
          id: evidenceId,
          kind: 'acceptance',
          observedAt: now().toISOString(),
          document: {
            operationId: input.operationId,
            idempotencyKey: context.idempotencyKey,
            orderId: input.orderId,
            orderUpdatedAt: result.order.updatedAt,
            marker: orderEditMarker(input.operationId),
          },
        });

        return {
          status: 'accepted',
          evidenceRefs: [evidenceId],
          providerRequestId: null,
        };
      } catch (error) {
        if (
          error instanceof ConnectorError &&
          error.failure.dispatch === 'not_dispatched'
        ) {
          if (!commitSent)
            await options.fence.finish(input.operationId, 'withheld');
          throw error;
        }
        // Before the commit was sent nothing can change in Shopify: a session is not an effect.
        if (!commitSent) {
          await options.fence.finish(input.operationId, 'withheld');
          throw withheld();
        }
        throw new ConnectorError({
          code:
            error instanceof ConnectorError
              ? error.failure.code
              : 'invalid_response',
          effect: 'unknown',
          retry: 'reconcile',
          dispatch: 'uncertain',
        });
      }
    },
  };

  return { read, calculate, proof, handler };
}
