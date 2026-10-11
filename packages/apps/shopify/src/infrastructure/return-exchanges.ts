import { randomUUID } from 'node:crypto';

import type {
  CapabilityHandler,
  ConnectorConnection,
  InvocationContext,
  ReturnExchangePlan,
  ReturnExchangeProof,
  ReturnExchangeRead,
} from '@luma/connections';
import { ConnectorError } from '@luma/connections';
import {
  returnExchangeProofSchema,
  returnExchangeQuotedSchema,
  returnExchangeReadSchema,
} from '@luma/connections/adapters';
import { API_VERSION, createClient, parse } from '@luma/connector-shopify';
import { settlementRefundProgress, toUnits } from '@luma/orders';
import { canonicalJson } from '@luma/platform';
import { z } from 'zod';

import type { ShopifyConnectorOptions } from './adapter.js';
import { adapterVersion, gid } from './schemas.js';

const money = z.object({
  amount: z.string().regex(/^\d{1,14}(?:\.\d{1,6})?$/),
  currencyCode: z.string().regex(/^[A-Z]{3}$/),
});
const bag = z.object({ presentmentMoney: money });
const connection = <T extends z.ZodType>(node: T) =>
  z.object({
    nodes: z.array(node),
    pageInfo: z.object({ hasNextPage: z.boolean() }),
  });
const line = z.object({
  id: gid('ReturnLineItem'),
  quantity: z.number().int().positive(),
  processedQuantity: z.number().int().nonnegative(),
  processableQuantity: z.number().int().nonnegative(),
  returnReasonNote: z
    .string()
    .nullable()
    .transform(
      (v) => v?.match(/^luma-ex:[0-9a-f-]{36}:[0-9a-f-]{36}$/)?.[0] ?? null,
    ),
  fulfillmentLineItem: z.object({
    id: gid('FulfillmentLineItem'),
    lineItem: z.object({ id: gid('LineItem') }),
  }),
});
const exchangeLine = z.object({
  id: gid('ExchangeLineItem'),
  variantId: gid('ProductVariant').nullable(),
  quantity: z.number().int().positive(),
  processedQuantity: z.number().int().nonnegative(),
  processableQuantity: z.number().int().nonnegative(),
  lineItems: z.array(z.object({ id: gid('LineItem') })).nullable(),
});
const returned = z.object({
  id: gid('Return'),
  status: z.string(),
  order: z.object({ id: gid('Order') }),
  returnLineItems: connection(line),
  exchangeLineItems: connection(exchangeLine),
});
const fields = `id status order { id } returnLineItems(first:20) { nodes { id quantity returnReasonNote ... on ReturnLineItem { processedQuantity processableQuantity fulfillmentLineItem { id lineItem { id } } } } pageInfo { hasNextPage } } exchangeLineItems(first:10,includeRemovedItems:true) { nodes { id variantId quantity processedQuantity processableQuantity lineItems { id } } pageInfo { hasNextPage } }`;
const descriptor = {
  version: '0',
  minimumRisk: 'low',
  idempotency: 'none',
  retry: { maxAttempts: 3, initialDelayMs: 1000 },
} as const;
const complete = (r: z.infer<typeof returned>) =>
  !r.returnLineItems.pageInfo.hasNextPage &&
  !r.exchangeLineItems.pageInfo.hasNextPage &&
  r.returnLineItems.nodes.length <= 20 &&
  r.exchangeLineItems.nodes.every((e) => (e.lineItems?.length ?? 0) <= 20);

function withheld(): never {
  throw new ConnectorError({
    code: 'conflict',
    effect: 'none',
    retry: 'never',
    dispatch: 'not_dispatched',
  });
}

/** Native exchange intent and processing, with one-shot writes and independent fulfillment/payment reads. */
export function createShopifyExchangeCapabilities(
  options: ShopifyConnectorOptions,
): ConnectorConnection['capabilities'] {
  const request = createClient(options),
    now = options.now ?? (() => new Date()),
    id = options.id ?? randomUUID;

  function check(c: InvocationContext) {
    if (
      c.tenant.tenantId !== options.tenantId ||
      c.connectionId !== options.connectionId ||
      c.provider !== 'shopify'
    )
      withheld();
  }

  async function evidence(
    capability:
      | 'returns.exchange.options.read'
      | 'returns.exchange.quote.read'
      | 'returns.exchange.proof.read',
    externalId: string,
    data: unknown,
    observedAt: string,
  ) {
    const observationId = id();
    await options.recordObservations({
      tenantId: options.tenantId,
      connectionId: options.connectionId,
      apiVersion: API_VERSION,
      capability,
      observations: [
        {
          id: observationId,
          source: {
            tenantId: options.tenantId,
            connectionId: options.connectionId,
            provider: 'shopify',
            resource:
              capability === 'returns.exchange.options.read' ? 'sku' : 'order',
            externalId,
            scopeKey: '',
          },
          kind: 'snapshot',
          observedAt,
          sourceUpdatedAt: null,
          sourceRevision: null,
          adapterVersion,
          schemaVersion: 1,
          data,
        },
      ],
    });

    return [observationId];
  }

  async function variant(inventoryItem: string) {
    gid('InventoryItem').parse(inventoryItem);
    const raw = await request(
      'query LumaExchangeVariant($id:ID!) { node(id:$id) { ... on InventoryItem { id tracked variant { id displayName inventoryQuantity } } } }',
      { id: inventoryItem },
    );
    const value = parse(
      z.object({
        id: gid('InventoryItem'),
        tracked: z.boolean(),
        variant: z.object({
          id: gid('ProductVariant'),
          displayName: z.string(),
          inventoryQuantity: z.number().int().nullable(),
        }),
      }),
      raw.node,
    );
    if (value.id !== inventoryItem) withheld();

    return value;
  }

  async function order(orderId: string) {
    gid('Order').parse(orderId);
    const raw = await request(
      `query LumaExchangeOrder($id:ID!) { node(id:$id) { ... on Order { id returns(first:5) { nodes { ${fields} } pageInfo { hasNextPage } } } } }`,
      { id: orderId },
    );
    const value = parse(
      z.object({ id: gid('Order'), returns: connection(returned) }),
      raw.node,
    );
    if (value.id !== orderId) withheld();

    return value;
  }

  async function find(plan: ReturnExchangePlan) {
    if (plan.order.scopeKey !== '') withheld();
    const value = await order(plan.order.externalId);
    const items = value.returns.nodes.filter((r) =>
      plan.kind === 'release'
        ? r.id === plan.returnId
        : r.returnLineItems.nodes.some(
            (l) => l.returnReasonNote === plan.marker,
          ),
    );

    return {
      items,
      complete: !value.returns.pageInfo.hasNextPage && items.every(complete),
    };
  }

  async function financial(r: z.infer<typeof returned>, orderId: string) {
    const raw = await request(
      `query LumaExchangeFinancial($id:ID!,$lines:[SuggestedOutcomeReturnLineItemInput!]!,$exchange:[SuggestedOutcomeExchangeLineItemInput!]!) { node(id:$id) { ... on Return { id suggestedFinancialOutcome(returnLineItems:$lines,exchangeLineItems:$exchange,refundMethodAllocation:ORIGINAL_PAYMENT_METHODS) { maximumRefundable { presentmentMoney { amount currencyCode } } financialTransfer { __typename ... on InvoiceReturnOutcome { amount { presentmentMoney { amount currencyCode } } } ... on RefundReturnOutcome { amount { presentmentMoney { amount currencyCode } } suggestedTransactions { amountSet { presentmentMoney { amount currencyCode } } kind parentTransaction { id } } } } } } } }`,
      {
        id: r.id,
        lines: r.returnLineItems.nodes.map((l) => ({
          id: l.id,
          quantity: l.quantity,
        })),
        exchange: r.exchangeLineItems.nodes.map((l) => ({
          id: l.id,
          quantity: l.quantity,
        })),
      },
    );
    const value = parse(
      z.object({
        id: gid('Return'),
        suggestedFinancialOutcome: z
          .object({
            maximumRefundable: bag,
            financialTransfer: z
              .discriminatedUnion('__typename', [
                z.object({
                  __typename: z.literal('InvoiceReturnOutcome'),
                  amount: bag,
                }),
                z.object({
                  __typename: z.literal('RefundReturnOutcome'),
                  amount: bag,
                  suggestedTransactions: z
                    .array(
                      z.object({
                        amountSet: bag,
                        kind: z.literal('SUGGESTED_REFUND'),
                        parentTransaction: z.object({
                          id: gid('OrderTransaction'),
                        }),
                      }),
                    )
                    .max(20),
                }),
              ])
              .nullable(),
          })
          .nullable(),
      }),
      raw.node,
    );
    if (value.id !== r.id || !value.suggestedFinancialOutcome) withheld();
    const payment = await payments(orderId),
      outcome = value.suggestedFinancialOutcome,
      transfer = outcome.financialTransfer;
    const currency = payment.presentmentCurrencyCode;
    if (transfer && transfer.amount.presentmentMoney.currencyCode !== currency)
      withheld();
    const amount = transfer?.amount.presentmentMoney.amount ?? '0';
    const kind =
      toUnits(amount) === 0n
        ? ('even' as const)
        : transfer?.__typename === 'InvoiceReturnOutcome'
          ? ('charge' as const)
          : ('refund' as const);
    const transactions =
      kind === 'refund' && transfer?.__typename === 'RefundReturnOutcome'
        ? transfer.suggestedTransactions.map((t) => ({
            parentId: t.parentTransaction.id,
            amount: t.amountSet.presentmentMoney.amount,
          }))
        : [];
    if (
      kind === 'refund' &&
      transfer?.__typename === 'RefundReturnOutcome' &&
      (outcome.maximumRefundable.presentmentMoney.currencyCode !== currency ||
        toUnits(outcome.maximumRefundable.presentmentMoney.amount) <
          toUnits(amount) ||
        transfer.suggestedTransactions.some(
          (t) =>
            t.amountSet.presentmentMoney.currencyCode !== currency ||
            toUnits(t.amountSet.presentmentMoney.amount) <= 0n,
        ) ||
        new Set(transactions.map((t) => t.parentId)).size !==
          transactions.length ||
        transactions.reduce((n, t) => n + toUnits(t.amount), 0n) !==
          toUnits(amount))
    )
      withheld();

    return {
      kind,
      amount,
      currency,
      transactions,
      priorSuccessfulTransactionIds: payment.transactions
        .filter(
          (t) => ['SALE', 'CAPTURE'].includes(t.kind) && t.status === 'SUCCESS',
        )
        .map((t) => t.id),
    };
  }

  async function payments(orderId: string) {
    const raw = await request(
      'query LumaExchangePayments($id:ID!) { node(id:$id) { ... on Order { id presentmentCurrencyCode totalOutstandingSet { presentmentMoney { amount currencyCode } } transactions(first:100) { id kind status amountSet { presentmentMoney { amount currencyCode } } parentTransaction { id } } } } }',
      { id: orderId },
    );
    const value = parse(
      z.object({
        id: gid('Order'),
        presentmentCurrencyCode: z.string().regex(/^[A-Z]{3}$/),
        totalOutstandingSet: bag,
        transactions: z
          .array(
            z.object({
              id: gid('OrderTransaction'),
              kind: z.string(),
              status: z.string(),
              amountSet: bag,
              parentTransaction: z
                .object({ id: gid('OrderTransaction') })
                .nullable(),
            }),
          )
          .max(99),
      }),
      raw.node,
    );
    if (
      value.id !== orderId ||
      new Set(value.transactions.map((t) => t.id)).size !==
        value.transactions.length
    )
      withheld();

    return value;
  }

  async function quote(input: ReturnExchangeRead) {
    const observedAt = now().toISOString(),
      plan = input.plan;
    let quoted = plan,
      available = true;
    if (plan.kind === 'request' || plan.kind === 'process') {
      const v = await variant(plan.replacement.inventoryItem.externalId);
      if (
        plan.replacement.inventoryItem.scopeKey !== '' ||
        v.variant.id !== plan.replacement.variantId
      )
        withheld();
      available =
        v.tracked &&
        v.variant.inventoryQuantity !== null &&
        v.variant.inventoryQuantity >= plan.replacement.quantity;
    }
    if (plan.kind === 'process') {
      const found = await find(plan),
        r = found.items[0];
      if (
        !found.complete ||
        found.items.length !== 1 ||
        !r ||
        r.id !== plan.returnId ||
        r.status !== 'OPEN' ||
        r.order.id !== plan.order.externalId ||
        r.returnLineItems.nodes.length !== plan.returnLines.length ||
        new Set(plan.returnLines.map((l) => l.id)).size !==
          plan.returnLines.length ||
        r.exchangeLineItems.nodes.length !== 1 ||
        r.returnLineItems.nodes.some(
          (l) =>
            l.processedQuantity !== 0 ||
            l.processableQuantity !== l.quantity ||
            l.returnReasonNote !== plan.marker,
        ) ||
        plan.returnLines.some(
          (l) =>
            !r.returnLineItems.nodes.some(
              (s) => s.id === l.id && s.quantity === l.quantity,
            ),
        ) ||
        r.exchangeLineItems.nodes[0]?.id !== plan.exchangeLine.id ||
        r.exchangeLineItems.nodes[0]?.quantity !== plan.replacement.quantity ||
        r.exchangeLineItems.nodes[0]?.variantId !==
          plan.replacement.variantId ||
        r.exchangeLineItems.nodes[0]?.processedQuantity !== 0 ||
        r.exchangeLineItems.nodes[0]?.processableQuantity !==
          plan.replacement.quantity
      )
        withheld();
      quoted = {
        ...plan,
        financial: await financial(r, plan.order.externalId),
      };
    }
    if (plan.kind === 'cancel') {
      const found = await find(plan),
        r = found.items[0];
      if (
        !found.complete ||
        found.items.length !== 1 ||
        r?.id !== plan.returnId ||
        r.status !== 'OPEN' ||
        r.order.id !== plan.order.externalId ||
        r.returnLineItems.nodes.length !== plan.lines.length ||
        plan.lines.some(
          (l) =>
            r.returnLineItems.nodes.filter(
              (s) =>
                s.fulfillmentLineItem.lineItem.id === l.source.externalId &&
                s.quantity === l.quantity &&
                s.returnReasonNote === plan.marker,
            ).length !== 1,
        ) ||
        r.exchangeLineItems.nodes.length !== 1 ||
        r.exchangeLineItems.nodes[0]?.variantId !==
          plan.replacement.variantId ||
        r.exchangeLineItems.nodes[0]?.quantity !== plan.replacement.quantity ||
        r.returnLineItems.nodes.some((l) => l.processedQuantity > 0) ||
        r.exchangeLineItems.nodes.some((l) => l.processedQuantity > 0)
      )
        withheld();
    }
    if (plan.kind === 'release') {
      const result = await proof(input);
      if (
        result.payment !== 'paid' ||
        result.fulfillmentOrderId !== plan.fulfillmentOrderId ||
        result.paymentHoldId !== plan.holdId
      )
        withheld();
    }

    return {
      plan: quoted,
      available,
      observedAt,
      evidenceRefs: await evidence(
        'returns.exchange.quote.read',
        plan.order.externalId,
        { operationId: input.operationId, plan: quoted, available },
        observedAt,
      ),
    };
  }

  async function fulfillment(r: z.infer<typeof returned>) {
    const ids = r.exchangeLineItems.nodes.flatMap(
      (l) => l.lineItems?.map((i) => i.id) ?? [],
    );
    if (!ids.length || new Set(ids).size !== ids.length)
      return { complete: true, items: [] };
    const raw = await request(
      'query LumaExchangeFulfillment($id:ID!) { node(id:$id) { ... on Order { id fulfillmentOrders(first:20) { nodes { id status fulfillmentHolds { id reason } lineItems(first:20) { nodes { totalQuantity lineItem { id } } pageInfo { hasNextPage } } } pageInfo { hasNextPage } } } } }',
      { id: r.order.id },
    );
    const value = parse(
      z.object({
        id: gid('Order'),
        fulfillmentOrders: connection(
          z.object({
            id: gid('FulfillmentOrder'),
            status: z.string(),
            fulfillmentHolds: z.array(
              z.object({ id: gid('FulfillmentHold'), reason: z.string() }),
            ),
            lineItems: connection(
              z.object({
                totalQuantity: z.number().int().nonnegative(),
                lineItem: z.object({ id: gid('LineItem') }),
              }),
            ),
          }),
        ),
      }),
      raw.node,
    );
    if (value.id !== r.order.id) withheld();

    return {
      complete:
        !value.fulfillmentOrders.pageInfo.hasNextPage &&
        value.fulfillmentOrders.nodes.every(
          (f) => !f.lineItems.pageInfo.hasNextPage,
        ),
      items: value.fulfillmentOrders.nodes.filter((f) =>
        f.lineItems.nodes.some((l) => ids.includes(l.lineItem.id)),
      ),
    };
  }

  async function paymentProof(
    plan: Extract<ReturnExchangePlan, { kind: 'process' | 'release' }>,
  ): Promise<ReturnExchangeProof['payment']> {
    const expected = plan.financial;
    if (expected.kind === 'even') {
      const value = await payments(plan.order.externalId);
      const raw = await request(
        'query LumaExchangeEvenProof($id:ID!) { node(id:$id) { ... on Return { id refunds(first:1) { nodes { id } pageInfo { hasNextPage } } } } }',
        { id: plan.returnId },
      );
      const current = parse(
        z.object({
          id: gid('Return'),
          refunds: connection(z.object({ id: gid('Refund') })),
        }),
        raw.node,
      );

      return current.id === plan.returnId &&
        current.refunds.nodes.length === 0 &&
        !current.refunds.pageInfo.hasNextPage &&
        value.presentmentCurrencyCode === expected.currency &&
        value.totalOutstandingSet.presentmentMoney.currencyCode ===
          expected.currency &&
        toUnits(value.totalOutstandingSet.presentmentMoney.amount) === 0n &&
        !value.transactions.some(
          (t) =>
            ['SALE', 'CAPTURE'].includes(t.kind) &&
            t.status === 'SUCCESS' &&
            !expected.priorSuccessfulTransactionIds.includes(t.id),
        )
        ? 'not_required'
        : 'unknown';
    }
    if (expected.kind === 'charge') {
      const value = await payments(plan.order.externalId);
      const relevant = value.transactions.filter(
        (t) =>
          ['SALE', 'CAPTURE'].includes(t.kind) &&
          !expected.priorSuccessfulTransactionIds.includes(t.id),
      );
      if (
        value.presentmentCurrencyCode !== expected.currency ||
        value.totalOutstandingSet.presentmentMoney.currencyCode !==
          expected.currency ||
        relevant.some(
          (t) =>
            t.amountSet.presentmentMoney.currencyCode !== expected.currency,
        )
      )
        return 'unknown';
      const paid = relevant
        .filter((t) => t.status === 'SUCCESS')
        .reduce((n, t) => n + toUnits(t.amountSet.presentmentMoney.amount), 0n);
      if (
        paid === toUnits(expected.amount) &&
        toUnits(value.totalOutstandingSet.presentmentMoney.amount) === 0n
      )
        return 'paid';
      if (paid > toUnits(expected.amount)) return 'unknown';
      if (paid > 0n && paid < toUnits(expected.amount))
        return toUnits(value.totalOutstandingSet.presentmentMoney.amount) ===
          toUnits(expected.amount) - paid
          ? 'partial'
          : 'unknown';
      if (
        relevant.some(
          (t) => t.status === 'PENDING' || t.status === 'AWAITING_RESPONSE',
        ) ||
        paid > 0n
      )
        return 'pending';
      if (
        relevant.length &&
        relevant.every((t) => ['FAILURE', 'ERROR'].includes(t.status))
      )
        return 'failed';

      return 'pending';
    }
    const raw = await request(
      'query LumaExchangeRefundProof($id:ID!) { node(id:$id) { ... on Return { id order { id } refunds(first:10) { nodes { id transactions(first:20) { nodes { kind status amountSet { presentmentMoney { amount currencyCode } } parentTransaction { id } } pageInfo { hasNextPage } } } pageInfo { hasNextPage } } } } }',
      { id: plan.returnId },
    );
    const value = parse(
      z.object({
        id: gid('Return'),
        order: z.object({ id: gid('Order') }),
        refunds: connection(
          z.object({
            id: gid('Refund'),
            transactions: connection(
              z.object({
                kind: z.string(),
                status: z.string(),
                amountSet: bag,
                parentTransaction: z
                  .object({ id: gid('OrderTransaction') })
                  .nullable(),
              }),
            ),
          }),
        ),
      }),
      raw.node,
    );
    if (
      value.id !== plan.returnId ||
      value.order.id !== plan.order.externalId ||
      value.refunds.pageInfo.hasNextPage ||
      value.refunds.nodes.length !== 1 ||
      value.refunds.nodes[0]!.transactions.pageInfo.hasNextPage
    )
      return 'unknown';
    const transactions = value.refunds.nodes[0]!.transactions.nodes;
    if (
      transactions.length !== expected.transactions.length ||
      transactions.some(
        (t) =>
          t.kind !== 'REFUND' ||
          t.amountSet.presentmentMoney.currencyCode !== expected.currency,
      ) ||
      expected.transactions.some(
        (t) =>
          transactions.filter(
            (s) =>
              s.parentTransaction?.id === t.parentId &&
              toUnits(s.amountSet.presentmentMoney.amount) ===
                toUnits(t.amount),
          ).length !== 1,
      )
    )
      return 'unknown';
    const state = settlementRefundProgress(
      {
        type: 'refund',
        orderId: plan.order.externalId,
        returnId: plan.returnId,
        createdAt: null,
        total: null,
        lines: [],
        transactions: transactions.map((t) => ({
          status:
            t.status === 'SUCCESS'
              ? 'success'
              : t.status === 'FAILURE' || t.status === 'ERROR'
                ? 'failed'
                : t.status === 'PENDING' || t.status === 'AWAITING_RESPONSE'
                  ? 'pending'
                  : 'unknown',
          amount: {
            amount: t.amountSet.presentmentMoney.amount,
            currency: t.amountSet.presentmentMoney.currencyCode,
          },
          processedAt: null,
          gateway: null,
        })),
      },
      { amount: expected.amount, currency: expected.currency },
    );

    return state === 'paid'
      ? 'paid'
      : state === 'failed'
        ? 'failed'
        : state === 'partial'
          ? 'partial'
          : state === 'pending'
            ? 'pending'
            : 'unknown';
  }

  async function proof(input: ReturnExchangeRead) {
    const observedAt = now().toISOString(),
      plan = input.plan;
    const result: Omit<ReturnExchangeProof, 'evidenceRefs'> = {
      outcome: 'inconclusive',
      observedAt,
      returnId: null,
      processLines: null,
      fulfillmentOrderId: null,
      paymentHoldId: null,
      fulfillmentReady: false,
      payment: 'unknown',
      financial:
        plan.kind === 'process' || plan.kind === 'release'
          ? plan.financial
          : null,
    };
    const found = await find(plan),
      r = found.items[0];
    if (found.complete && found.items.length > 1) result.outcome = 'failed';
    if (found.complete && found.items.length === 1 && r) {
      result.returnId = r.id;
      const bound =
        r.order.id === plan.order.externalId &&
        r.returnLineItems.nodes.every(
          (l) => l.returnReasonNote === plan.marker,
        );
      if (!bound) result.outcome = 'failed';
      else if (plan.kind === 'cancel')
        result.outcome =
          r.id === plan.returnId &&
          r.status === 'CANCELED' &&
          r.returnLineItems.nodes.length === plan.lines.length &&
          plan.lines.every(
            (l) =>
              r.returnLineItems.nodes.filter(
                (s) =>
                  s.fulfillmentLineItem.lineItem.id === l.source.externalId &&
                  s.quantity === l.quantity,
              ).length === 1,
          ) &&
          r.exchangeLineItems.nodes.length === 1 &&
          r.exchangeLineItems.nodes[0]?.variantId ===
            plan.replacement.variantId &&
          r.exchangeLineItems.nodes[0]?.quantity ===
            plan.replacement.quantity &&
          r.returnLineItems.nodes.every((l) => l.processedQuantity === 0) &&
          r.exchangeLineItems.nodes.every((l) => l.processedQuantity === 0)
            ? 'passed'
            : 'inconclusive';
      else if (plan.kind === 'request') {
        const e = r.exchangeLineItems.nodes[0];
        const matching =
          r.returnLineItems.nodes.length === plan.lines.length &&
          plan.lines.every(
            (l) =>
              r.returnLineItems.nodes.filter(
                (s) =>
                  s.fulfillmentLineItem.lineItem.id === l.source.externalId &&
                  s.quantity === l.quantity,
              ).length === 1,
          ) &&
          r.exchangeLineItems.nodes.length === 1 &&
          e?.variantId === plan.replacement.variantId &&
          e.quantity === plan.replacement.quantity;
        result.outcome = matching && r.status === 'OPEN' ? 'passed' : 'failed';
        if (
          matching &&
          e &&
          r.returnLineItems.nodes.every((l) => l.processedQuantity === 0) &&
          e.processedQuantity === 0
        ) {
          result.processLines = {
            returnLines: r.returnLineItems.nodes.map((l) => ({
              id: l.id,
              quantity: l.quantity,
            })),
            exchangeLine: { id: e.id, quantity: e.quantity },
          };
          try {
            result.financial = await financial(r, plan.order.externalId);
            result.payment =
              result.financial.kind === 'even' ? 'not_required' : 'pending';
          } catch {
            // Intent is independently established even while its financial quote is unavailable.
            result.financial = null;
            result.payment = 'unknown';
          }
        }
      } else {
        const e = r.exchangeLineItems.nodes[0],
          f = await fulfillment(r);
        const processed =
          r.exchangeLineItems.nodes.length === 1 &&
          e?.processedQuantity === e?.quantity &&
          r.returnLineItems.nodes.every(
            (l) => l.processedQuantity === l.quantity,
          );
        const scoped =
          r.id === plan.returnId &&
          r.returnLineItems.nodes.length === plan.returnLines.length &&
          plan.returnLines.every(
            (l) =>
              r.returnLineItems.nodes.filter(
                (s) => s.id === l.id && s.quantity === l.quantity,
              ).length === 1,
          ) &&
          e?.id === plan.exchangeLine.id &&
          e.variantId === plan.replacement.variantId &&
          e.quantity === plan.replacement.quantity;
        if (!scoped) result.outcome = 'failed';
        else if (processed && f.complete && f.items.length === 1 && e) {
          const target = f.items[0]!;
          const ids = e.lineItems?.map((l) => l.id) ?? [];
          const matching =
            target.lineItems.nodes.length === ids.length &&
            target.lineItems.nodes.every((l) => ids.includes(l.lineItem.id)) &&
            target.lineItems.nodes.reduce((n, l) => n + l.totalQuantity, 0) ===
              e.quantity &&
            (plan.kind !== 'release' || target.id === plan.fulfillmentOrderId);
          if (matching) {
            result.fulfillmentOrderId = target.id;
            const holds = target.fulfillmentHolds.filter(
              (h) => h.reason === 'AWAITING_PAYMENT',
            );
            result.paymentHoldId = holds.length === 1 ? holds[0]!.id : null;
            result.fulfillmentReady =
              ['OPEN', 'IN_PROGRESS', 'CLOSED'].includes(target.status) &&
              target.fulfillmentHolds.length === 0;
            result.payment = await paymentProof(plan);
            result.outcome =
              target.status === 'CANCELLED'
                ? 'failed'
                : plan.kind === 'release'
                  ? result.payment === 'paid' &&
                    !target.fulfillmentHolds.some((h) => h.id === plan.holdId)
                    ? 'passed'
                    : 'inconclusive'
                  : 'passed';
          } else result.outcome = 'failed';
        } else if (f.complete && f.items.length > 1) result.outcome = 'failed';
      }
    }

    return {
      ...result,
      evidenceRefs: await evidence(
        'returns.exchange.proof.read',
        plan.order.externalId,
        { operationId: input.operationId, ...result },
        observedAt,
      ),
    };
  }

  async function allocate(
    plan: Extract<ReturnExchangePlan, { kind: 'request' }>,
  ) {
    const value = await order(plan.order.externalId);
    if (
      value.returns.pageInfo.hasNextPage ||
      value.returns.nodes.some((r) => !complete(r)) ||
      value.returns.nodes.some((r) =>
        r.returnLineItems.nodes.some((l) => l.returnReasonNote === plan.marker),
      )
    )
      withheld();
    const raw = await request(
      'query LumaExchangeReturnable($id:ID!) { node(id:$id) { ... on Order { id fulfillments { status fulfillmentLineItems(first:100) { nodes { id quantity lineItem { id } } pageInfo { hasNextPage } } } } } }',
      { id: plan.order.externalId },
    );
    const source = parse(
      z.object({
        id: gid('Order'),
        fulfillments: z.array(
          z.object({
            status: z.string(),
            fulfillmentLineItems: connection(
              z.object({
                id: gid('FulfillmentLineItem'),
                quantity: z.number().int().nonnegative(),
                lineItem: z.object({ id: gid('LineItem') }),
              }),
            ),
          }),
        ),
      }),
      raw.node,
    );
    if (
      source.id !== plan.order.externalId ||
      source.fulfillments.some(
        (f) => f.fulfillmentLineItems.pageInfo.hasNextPage,
      ) ||
      new Set(plan.lines.map((l) => l.source.externalId)).size !==
        plan.lines.length
    )
      withheld();
    const used = new Map<string, number>();
    for (const r of value.returns.nodes)
      if (!['CANCELED', 'DECLINED'].includes(r.status))
        for (const l of r.returnLineItems.nodes)
          used.set(
            l.fulfillmentLineItem.id,
            (used.get(l.fulfillmentLineItem.id) ?? 0) + l.quantity,
          );

    return plan.lines.map((l) => {
      gid('LineItem').parse(l.source.externalId);
      if (l.source.scopeKey !== plan.order.externalId) withheld();
      const shipped = source.fulfillments
        .filter((f) => f.status === 'SUCCESS')
        .flatMap((f) => f.fulfillmentLineItems.nodes)
        .filter((s) => s.lineItem.id === l.source.externalId);
      if (
        shipped.length !== 1 ||
        shipped[0]!.quantity - (used.get(shipped[0]!.id) ?? 0) < l.quantity
      )
        withheld();

      return {
        fulfillmentLineItemId: shipped[0]!.id,
        quantity: l.quantity,
        returnReason: z
          .enum([
            'SIZE_TOO_SMALL',
            'SIZE_TOO_LARGE',
            'UNWANTED',
            'DEFECTIVE',
            'WRONG_ITEM',
            'OTHER',
            'UNKNOWN',
            'STYLE',
            'COLOR',
            'NOT_AS_DESCRIBED',
          ])
          .parse(l.reason),
        returnReasonNote: plan.marker,
      };
    });
  }

  function writer(kind: ReturnExchangePlan['kind']) {
    return {
      descriptor: {
        version: '0',
        minimumRisk: 'high',
        permission: 'shopify:returns.manage',
        idempotency: 'none',
        retry: { maxAttempts: 1, initialDelayMs: 0 },
      },
      parseInput: (v: unknown) => returnExchangeReadSchema.parse(v),
      parseOutput: (v: unknown) =>
        z
          .object({
            status: z.literal('accepted'),
            evidenceRefs: z.array(z.string().uuid()).min(1),
            providerRequestId: z.string().nullable(),
          })
          .strict()
          .parse(v),
      async run(context: InvocationContext, input: ReturnExchangeRead) {
        check(context);
        if (input.plan.kind !== kind || !context.idempotencyKey) withheld();
        const current = await quote(input),
          plan = input.plan;
        if (
          !current.available ||
          canonicalJson(current.plan) !== canonicalJson(plan)
        )
          withheld();
        let query: string, variables: Record<string, unknown>;
        if (plan.kind === 'request') {
          const lines = await allocate(plan);
          query =
            'mutation LumaExchangeRequest($input:ReturnInput!) { result:returnCreate(returnInput:$input) { return { id } userErrors { field message } } }';
          variables = {
            input: {
              orderId: plan.order.externalId,
              // The transition flag keeps request approval from also confirming a legacy exchange.
              unprocessed: true,
              returnLineItems: lines,
              exchangeLineItems: [
                {
                  variantId: plan.replacement.variantId,
                  quantity: plan.replacement.quantity,
                },
              ],
            },
          };
        } else if (plan.kind === 'process') {
          query =
            'mutation LumaExchangeProcess($input:ReturnProcessInput!) { result:returnProcess(input:$input) { return { id } userErrors { field message } } }';
          variables = {
            input: {
              returnId: plan.returnId,
              returnLineItems: plan.returnLines,
              exchangeLineItems: [plan.exchangeLine],
              notifyCustomer: false,
              note: plan.marker,
              ...(plan.financial.kind === 'refund'
                ? {
                    financialTransfer: {
                      issueRefund: {
                        allowOverRefunding: false,
                        orderTransactions: plan.financial.transactions.map(
                          (t) => ({
                            parentId: t.parentId,
                            transactionAmount: {
                              amount: t.amount,
                              currencyCode: plan.financial.currency,
                            },
                          }),
                        ),
                      },
                    },
                  }
                : {}),
            },
          };
        } else if (plan.kind === 'cancel') {
          query =
            'mutation LumaExchangeCancel($id:ID!) { result:returnCancel(id:$id) { return { id } userErrors { field message } } }';
          variables = { id: plan.returnId };
        } else {
          query =
            'mutation LumaExchangeRelease($id:ID!,$holds:[ID!]) { result:fulfillmentOrderReleaseHold(id:$id,holdIds:$holds) { fulfillmentOrder { id } userErrors { field message } } }';
          variables = { id: plan.fulfillmentOrderId, holds: [plan.holdId] };
        }
        try {
          const raw = await request(query, variables);
          const value = parse(
            z.object({
              return: z
                .object({ id: gid('Return') })
                .nullable()
                .optional(),
              fulfillmentOrder: z
                .object({ id: gid('FulfillmentOrder') })
                .nullable()
                .optional(),
              userErrors: z.array(
                z.object({
                  field: z.array(z.string()).nullable(),
                  message: z.string(),
                }),
              ),
            }),
            raw.result,
          );
          if (value.userErrors.length) withheld();
          if (
            plan.kind === 'release'
              ? value.fulfillmentOrder?.id !== plan.fulfillmentOrderId
              : !value.return ||
                (plan.kind !== 'request' && value.return.id !== plan.returnId)
          )
            throw new Error('Exchange response unavailable');

          return {
            status: 'accepted' as const,
            providerRequestId:
              value.return?.id ?? value.fulfillmentOrder?.id ?? null,
            evidenceRefs: current.evidenceRefs,
          };
        } catch (error) {
          if (
            error instanceof ConnectorError &&
            error.failure.dispatch === 'not_dispatched'
          )
            throw error;
          throw new ConnectorError({
            code: 'unavailable',
            effect: 'unknown',
            retry: 'reconcile',
          });
        }
      },
    } satisfies CapabilityHandler<'returns.exchange.request'>;
  }

  const quoted: CapabilityHandler<'returns.exchange.quote.read'> = {
    descriptor,
    parseInput: (v) => returnExchangeReadSchema.parse(v),
    parseOutput: (v) => returnExchangeQuotedSchema.parse(v),
    run: async (c, input) => {
      check(c);

      return quote(input);
    },
  };
  const proven: CapabilityHandler<'returns.exchange.proof.read'> = {
    descriptor,
    parseInput: (v) => returnExchangeReadSchema.parse(v),
    parseOutput: (v) => returnExchangeProofSchema.parse(v),
    run: async (c, input) => {
      check(c);

      return proof(input);
    },
  };
  const choices: CapabilityHandler<'returns.exchange.options.read'> = {
    descriptor,
    parseInput: (v) =>
      z
        .object({
          inventoryItems: z
            .array(
              z
                .object({
                  externalId: gid('InventoryItem'),
                  scopeKey: z.literal(''),
                })
                .strict(),
            )
            .min(1)
            .max(50),
        })
        .strict()
        .parse(v),
    parseOutput: (v) =>
      z
        .object({
          choices: z.array(
            z.object({
              inventoryItem: z.object({
                externalId: gid('InventoryItem'),
                scopeKey: z.literal(''),
              }),
              variantId: gid('ProductVariant'),
              name: z.string(),
              available: z.number().int().nullable(),
            }),
          ),
          observedAt: z.string().datetime(),
          evidenceRefs: z.array(z.string().uuid()).min(1),
          complete: z.boolean(),
        })
        .strict()
        .parse(v),
    async run(c, input) {
      check(c);
      const observedAt = now().toISOString();
      if (
        new Set(input.inventoryItems.map((i) => i.externalId)).size !==
        input.inventoryItems.length
      )
        withheld();
      const raw = await request(
        'query LumaExchangeChoices($ids:[ID!]!) { nodes(ids:$ids) { ... on InventoryItem { id tracked variant { id displayName inventoryQuantity } } } }',
        { ids: input.inventoryItems.map((i) => i.externalId) },
      );
      const nodes = parse(
        z.array(
          z
            .object({
              id: gid('InventoryItem'),
              tracked: z.boolean(),
              variant: z.object({
                id: gid('ProductVariant'),
                displayName: z.string(),
                inventoryQuantity: z.number().int().nullable(),
              }),
            })
            .nullable(),
        ),
        raw.nodes,
      );
      const source = nodes.filter((n) => n !== null);
      if (
        source.some(
          (n) => !input.inventoryItems.some((i) => i.externalId === n.id),
        ) ||
        new Set(source.map((n) => n.id)).size !== source.length
      )
        withheld();
      const items = source.map((v) => ({
        inventoryItem: { externalId: v.id, scopeKey: '' },
        variantId: v.variant.id,
        name: v.variant.displayName,
        available: v.tracked ? v.variant.inventoryQuantity : null,
      }));

      return {
        choices: items,
        observedAt,
        complete: items.length === input.inventoryItems.length,
        evidenceRefs: await evidence(
          'returns.exchange.options.read',
          input.inventoryItems[0]!.externalId,
          { items },
          observedAt,
        ),
      };
    },
  };

  return {
    'returns.exchange.options.read': choices,
    'returns.exchange.quote.read': quoted,
    'returns.exchange.proof.read': proven,
    'returns.exchange.request': writer('request'),
    'returns.exchange.process': writer('process'),
    'returns.exchange.cancel': writer('cancel'),
    'returns.exchange.release': writer('release'),
  };
}
