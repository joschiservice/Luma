import { randomUUID } from 'node:crypto';

import type {
  CapabilityHandler,
  ConnectorConnection,
  InvocationContext,
  ReturnSettlementPlan,
  ReturnSettlementQuote,
  ReturnSettlementWrite,
} from '@luma/connections';
import { ConnectorError } from '@luma/connections';
import {
  returnSettlementProofSchema,
  returnSettlementQuotedSchema,
  returnSettlementQuoteSchema,
  returnSettlementWriteSchema,
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
const refund = z.object({
  id: gid('Refund'),
  note: z
    .string()
    .nullable()
    .transform((v) => v?.match(/^luma-rs:[0-9a-f-]{36}$/)?.[0] ?? null),
  refundLineItems: connection(
    z.object({
      quantity: z.number().int().positive(),
      restockType: z.string(),
      restocked: z.boolean(),
      lineItem: z.object({ id: gid('LineItem') }),
    }),
  ),
  transactions: connection(
    z.object({
      kind: z.string(),
      status: z.string(),
      amountSet: bag,
      processedAt: z.string().nullable(),
      gateway: z.string(),
      parentTransaction: z.object({ id: gid('OrderTransaction') }).nullable(),
    }),
  ),
});
const refundFields = `id note refundLineItems(first:20) { nodes { quantity restockType restocked lineItem { id } } pageInfo { hasNextPage } } transactions(first:20) { nodes { kind status amountSet { presentmentMoney { amount currencyCode } } processedAt gateway parentTransaction { id } } pageInfo { hasNextPage } }`;
const marker = (id: string) => `luma-rs:${id}`;

function withheld(): never {
  throw new ConnectorError({
    code: 'conflict',
    effect: 'none',
    retry: 'never',
    dispatch: 'not_dispatched',
  });
}

const readDescriptor = {
  version: '0',
  minimumRisk: 'low',
  idempotency: 'none',
  retry: { maxAttempts: 3, initialDelayMs: 1000 },
} as const;

/** Financial-only Shopify refunds: exact quote, native idempotency and independent payment reconciliation. */
export function createShopifySettlementCapabilities(
  options: ShopifyConnectorOptions,
): ConnectorConnection['capabilities'] {
  const request = createClient(options),
    now = options.now ?? (() => new Date()),
    id = options.id ?? randomUUID;

  function check(context: InvocationContext) {
    if (
      context.tenant.tenantId !== options.tenantId ||
      context.connectionId !== options.connectionId ||
      context.provider !== 'shopify'
    )
      withheld();
  }

  async function evidence(
    capability:
      'returns.settlement.quote.read' | 'returns.settlement.proof.read',
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
            resource: 'refund',
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

  // Quotes retain only monetary values and source identities, never customer or gateway credentials.
  async function calculate(
    input: Extract<ReturnSettlementQuote, { kind: 'refund' }>,
  ) {
    gid('Order').parse(input.order.externalId);
    if (
      input.order.scopeKey ||
      input.lines.length > 20 ||
      new Set(input.lines.map((l) => l.orderLine.externalId)).size !==
        input.lines.length ||
      input.lines.some((l) => l.orderLine.scopeKey !== input.order.externalId)
    )
      withheld();
    for (const line of input.lines)
      gid('LineItem').parse(line.orderLine.externalId);
    const observedAt = now().toISOString();
    const raw = await request(
      `query LumaReturnRefundQuote($id:ID!,$lines:[RefundLineItemInput!]) { node(id:$id) { ... on Order { id suggestedRefund(refundLineItems:$lines,refundShipping:false,suggestFullRefund:false) { amountSet { presentmentMoney { amount currencyCode } } maximumRefundableSet { presentmentMoney { amount currencyCode } } refundLineItems { quantity lineItem { id } } suggestedTransactions { amountSet { presentmentMoney { amount currencyCode } } gateway kind parentTransaction { id } } } } } }`,
      {
        id: input.order.externalId,
        lines: input.lines.map((l) => ({
          lineItemId: l.orderLine.externalId,
          quantity: l.quantity,
          restockType: 'NO_RESTOCK',
        })),
      },
    );
    const order = parse(
      z.object({
        id: gid('Order'),
        suggestedRefund: z.object({
          amountSet: bag,
          maximumRefundableSet: bag,
          refundLineItems: z.array(
            z.object({
              quantity: z.number().int().positive(),
              lineItem: z.object({ id: gid('LineItem') }),
            }),
          ),
          suggestedTransactions: z
            .array(
              z.object({
                amountSet: bag,
                gateway: z.string(),
                kind: z.literal('SUGGESTED_REFUND'),
                parentTransaction: z.object({ id: gid('OrderTransaction') }),
              }),
            )
            .min(1)
            .max(20),
        }),
      }),
      raw.node,
    );
    const s = order.suggestedRefund,
      a = s.amountSet.presentmentMoney;
    if (
      order.id !== input.order.externalId ||
      toUnits(a.amount) <= 0n ||
      s.maximumRefundableSet.presentmentMoney.currencyCode !== a.currencyCode ||
      toUnits(s.maximumRefundableSet.presentmentMoney.amount) <
        toUnits(a.amount) ||
      s.refundLineItems.length !== input.lines.length ||
      input.lines.some(
        (l) =>
          s.refundLineItems.filter(
            (r) =>
              r.lineItem.id === l.orderLine.externalId &&
              r.quantity === l.quantity,
          ).length !== 1,
      ) ||
      new Set(s.suggestedTransactions.map((t) => t.parentTransaction.id))
        .size !== s.suggestedTransactions.length ||
      s.suggestedTransactions.some(
        (t) =>
          toUnits(t.amountSet.presentmentMoney.amount) <= 0n ||
          t.amountSet.presentmentMoney.currencyCode !== a.currencyCode,
      ) ||
      s.suggestedTransactions.reduce(
        (sum, t) => sum + toUnits(t.amountSet.presentmentMoney.amount),
        0n,
      ) !== toUnits(a.amount)
    )
      withheld();
    const plan: ReturnSettlementPlan = {
      ...input,
      amount: a.amount,
      currency: a.currencyCode,
      transactions: s.suggestedTransactions.map((t) => ({
        parentId: t.parentTransaction.id,
        gateway: t.gateway,
        amount: t.amountSet.presentmentMoney.amount,
      })),
    };

    return {
      plan,
      observedAt,
      evidenceRefs: await evidence(
        'returns.settlement.quote.read',
        input.order.externalId,
        plan,
        observedAt,
      ),
    };
  }

  async function read(input: ReturnSettlementWrite) {
    if (input.plan.kind !== 'refund') withheld();
    const plan = input.plan;
    const observedAt = now().toISOString();
    const raw = await request(
      `query LumaReturnRefundProof($id:ID!) { node(id:$id) { ... on Order { id refunds(first:100) { id note } } } }`,
      { id: plan.order.externalId },
    );
    const order = parse(
      z.object({
        id: gid('Order'),
        refunds: z.array(refund.pick({ id: true, note: true })).max(100),
      }),
      raw.node,
    );
    if (order.id !== plan.order.externalId) withheld();
    const matches = order.refunds.filter(
      (r) => r.note === marker(input.operationId),
    );
    let outcome: 'passed' | 'failed' | 'inconclusive' = 'inconclusive',
      payment: 'paid' | 'failed' | 'pending' | 'partial' | null = null;
    let details: unknown = null;
    // At the provider bound we cannot prove a complete absence or uniqueness.
    if (order.refunds.length < 100 && matches.length === 1) {
      const selected = matches[0]!;
      const detail = await request(
        `query LumaReturnRefundDetail($id:ID!) { node(id:$id) { ... on Refund { ${refundFields} } } }`,
        { id: selected.id },
      );
      const r = parse(refund, detail.node);
      if (r.id !== selected.id || r.note !== marker(input.operationId))
        withheld();
      details = {
        id: r.id,
        lines: r.refundLineItems.nodes,
        transactions: r.transactions.nodes,
      };
      const exact =
        !r.refundLineItems.pageInfo.hasNextPage &&
        !r.transactions.pageInfo.hasNextPage &&
        r.refundLineItems.nodes.length === plan.lines.length &&
        plan.lines.every(
          (l) =>
            r.refundLineItems.nodes.filter(
              (n) =>
                n.lineItem.id === l.orderLine.externalId &&
                n.quantity === l.quantity &&
                n.restockType === 'NO_RESTOCK' &&
                !n.restocked,
            ).length === 1,
        ) &&
        r.transactions.nodes.length === plan.transactions.length &&
        plan.transactions.every(
          (t) =>
            r.transactions.nodes.filter(
              (n) =>
                n.kind === 'REFUND' &&
                n.parentTransaction?.id === t.parentId &&
                n.gateway === t.gateway &&
                n.amountSet.presentmentMoney.currencyCode === plan.currency &&
                toUnits(n.amountSet.presentmentMoney.amount) ===
                  toUnits(t.amount),
            ).length === 1,
        );
      if (exact) {
        const progress = settlementRefundProgress(
          {
            type: 'refund',
            orderId: plan.order.externalId,
            returnId: null,
            createdAt: null,
            total: null,
            lines: [],
            transactions: r.transactions.nodes.map((t) => ({
              status:
                t.status === 'SUCCESS'
                  ? 'success'
                  : ['PENDING', 'AWAITING_RESPONSE'].includes(t.status)
                    ? 'pending'
                    : ['FAILURE', 'ERROR'].includes(t.status)
                      ? 'failed'
                      : 'unknown',
              amount: {
                amount: t.amountSet.presentmentMoney.amount,
                currency: t.amountSet.presentmentMoney.currencyCode,
              },
              processedAt: t.processedAt,
              gateway: t.gateway,
            })),
          },
          { amount: plan.amount, currency: plan.currency },
        );
        payment = progress === 'unknown' ? null : progress;
        outcome =
          progress === 'paid'
            ? 'passed'
            : progress === 'failed'
              ? 'failed'
              : 'inconclusive';
      } else
        outcome =
          r.refundLineItems.pageInfo.hasNextPage ||
          r.transactions.pageInfo.hasNextPage
            ? 'inconclusive'
            : 'failed';
    }
    const normalized = {
      operationId: input.operationId,
      matches: matches.map((r) => ({ id: r.id })),
      outcome,
      payment,
      details,
    };

    return {
      absent: order.refunds.length < 100 && matches.length === 0,
      outcome,
      payment,
      observedAt,
      evidenceRefs: await evidence(
        'returns.settlement.proof.read',
        input.operationId,
        normalized,
        observedAt,
      ),
    };
  }

  const quoted: CapabilityHandler<'returns.settlement.quote.read'> = {
    descriptor: readDescriptor,
    parseInput: (v) => returnSettlementQuoteSchema.parse(v),
    parseOutput: (v) => returnSettlementQuotedSchema.parse(v),
    async run(context, input) {
      check(context);
      if (input.kind !== 'refund') withheld();

      return calculate(input);
    },
  };
  const proof: CapabilityHandler<'returns.settlement.proof.read'> = {
    descriptor: readDescriptor,
    parseInput: (v) => returnSettlementWriteSchema.parse(v),
    parseOutput: (v) => returnSettlementProofSchema.parse(v),
    async run(context, input) {
      check(context);
      const result = await read(input);

      return {
        outcome: result.outcome,
        payment: result.payment,
        observedAt: result.observedAt,
        evidenceRefs: result.evidenceRefs,
      };
    },
  };
  const write: CapabilityHandler<'returns.refund'> = {
    descriptor: {
      version: '0',
      minimumRisk: 'high',
      permission: 'shopify:returns.manage',
      idempotency: 'provider_key',
      retry: { maxAttempts: 1, initialDelayMs: 0 },
    },
    parseInput: (v) => returnSettlementWriteSchema.parse(v),
    parseOutput: (v) =>
      z
        .object({
          status: z.literal('accepted'),
          evidenceRefs: z.array(z.string().uuid()),
          providerRequestId: z.string().nullable(),
        })
        .strict()
        .parse(v),
    async run(context, input) {
      check(context);
      if (input.plan.kind !== 'refund' || !context.idempotencyKey) withheld();
      const plan = input.plan;
      try {
        const current = await calculate({
          kind: 'refund',
          order: plan.order,
          lines: plan.lines,
        });
        if (canonicalJson(current.plan) !== canonicalJson(plan)) withheld();
        const existing = await read(input);
        // A pre-existing matching effect or failed verification is never dispatched again.
        if (!existing.absent) withheld();
      } catch (error) {
        if (error instanceof ConnectorError)
          throw new ConnectorError({
            ...error.failure,
            effect: 'none',
            dispatch: 'not_dispatched',
          });
        throw error;
      }
      const raw = await request(
        `mutation LumaReturnRefund($input:RefundInput!,$key:String!) { refundCreate(input:$input) @idempotent(key:$key) { refund { id } userErrors { field message } } }`,
        {
          key: input.operationId,
          input: {
            orderId: plan.order.externalId,
            currency: plan.currency,
            note: marker(input.operationId),
            notify: false,
            allowOverRefunding: false,
            refundLineItems: plan.lines.map((l) => ({
              lineItemId: l.orderLine.externalId,
              quantity: l.quantity,
              restockType: 'NO_RESTOCK',
            })),
            transactions: plan.transactions.map((t) => ({
              orderId: plan.order.externalId,
              parentId: t.parentId,
              gateway: t.gateway,
              kind: 'REFUND',
              amount: t.amount,
            })),
          },
        },
      );
      const result = z
        .object({
          refund: z.object({ id: gid('Refund') }).nullable(),
          userErrors: z.array(
            z.object({
              field: z.array(z.string()).nullable(),
              message: z.string(),
            }),
          ),
        })
        .safeParse(raw.refundCreate);
      if (
        !result.success ||
        !result.data.refund ||
        result.data.userErrors.length
      )
        throw new ConnectorError({
          code: 'invalid_response',
          effect: 'unknown',
          retry: 'reconcile',
        });

      return {
        status: 'accepted',
        evidenceRefs: await evidence(
          'returns.settlement.proof.read',
          result.data.refund.id,
          { accepted: true, operationId: input.operationId },
          now().toISOString(),
        ),
        providerRequestId: null,
      };
    },
  };

  return {
    'returns.settlement.quote.read': quoted,
    'returns.settlement.proof.read': proof,
    'returns.refund': write,
  };
}
