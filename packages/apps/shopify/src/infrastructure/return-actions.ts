import { randomUUID } from 'node:crypto';

import {
  type CapabilityHandler,
  type CapabilityInput,
  type ConnectorConnection,
  ConnectorError,
  type CreatedReturnSnapshot,
  type InvocationContext,
  type Observation,
  type ReturnOptionSnapshot,
} from '@luma/connections';
import { API_VERSION, createClient, parse } from '@luma/connector-shopify';
import { z } from 'zod';

import type { ShopifyConnectorOptions } from './adapter.js';
import { adapterVersion, gid } from './schemas.js';

const ref = (externalId: string, scopeKey = '') => ({ externalId, scopeKey });
const source = z
  .object({ externalId: z.string().min(1), scopeKey: z.literal('') })
  .strict();
const reasons = [
  'SIZE_TOO_SMALL',
  'SIZE_TOO_LARGE',
  'UNWANTED',
  'DEFECTIVE',
  'WRONG_ITEM',
  'OTHER',
] as const;
const reason = z
  .object({ externalId: z.enum(reasons), scopeKey: z.literal('') })
  .strict();
const pageInput = z
  .object({ limit: z.number().int().min(1).max(100) })
  .strict();
const lookupInput = pageInput
  .extend({
    order: source,
    lumaCaseId: z.string().uuid(),
    requestedReturn: source.optional(),
  })
  .strict()
  .transform(({ requestedReturn, ...v }) => ({
    ...v,
    ...(requestedReturn ? { requestedReturn } : {}),
  }));
const createInput = z
  .object({
    lumaCaseId: z.string().uuid(),
    order: source,
    requestedReturn: source.optional(),
    warehouse: z
      .object({ externalId: z.literal('shopify'), scopeKey: z.literal('') })
      .strict(),
    reason,
    lines: z
      .array(
        z
          .object({
            orderLine: z
              .object({ externalId: gid('LineItem'), scopeKey: gid('Order') })
              .strict(),
            quantity: z
              .object({
                amount: z.string().regex(/^[1-9]\d{0,8}$/),
                unit: z.literal('each'),
              })
              .strict(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .refine(
    (v) =>
      new Set(v.lines.map((l) => l.orderLine.externalId)).size ===
      v.lines.length,
  )
  .transform(({ requestedReturn, ...v }) => ({
    ...v,
    ...(requestedReturn ? { requestedReturn } : {}),
  }));
const connection = <T extends z.ZodType>(node: T) =>
  z.object({
    nodes: z.array(node),
    pageInfo: z.object({ hasNextPage: z.boolean() }),
  });
const returned = z.object({
  id: gid('Return'),
  name: z.string(),
  status: z.string(),
  createdAt: z.string().datetime(),
  returnLineItems: connection(
    z.object({
      quantity: z.number().int().positive(),
      // Only the exact machine marker is retained. Other notes never enter evidence.
      returnReasonNote: z
        .string()
        .nullable()
        .transform((v) => v?.match(/^luma-rc:[0-9a-f-]{36}$/)?.[0] ?? null),
      fulfillmentLineItem: z.object({
        id: gid('FulfillmentLineItem'),
        lineItem: z.object({ id: gid('LineItem') }),
      }),
    }),
  ),
});
const returnFields = `id name status createdAt returnLineItems(first: 20) { nodes { quantity returnReasonNote ... on ReturnLineItem { fulfillmentLineItem { id lineItem { id } } } } pageInfo { hasNextPage } }`;
const orderSchema = z.object({
  id: gid('Order'),
  returns: connection(returned),
});
const external = z.object({ externalId: z.string(), scopeKey: z.string() });
const output = <T extends z.ZodType>(data: T) =>
  z.object({
    items: z.array(
      z.object({
        id: z.string().uuid(),
        source: external.extend({
          tenantId: z.string(),
          connectionId: z.string(),
          provider: z.literal('shopify'),
          resource: z.enum(['location', 'return_reason', 'return']),
        }),
        kind: z.literal('snapshot'),
        observedAt: z.string().datetime(),
        sourceUpdatedAt: z.null(),
        sourceRevision: z.null(),
        adapterVersion: z.string(),
        schemaVersion: z.literal(1),
        data,
      }),
    ),
    nextCursor: z.null(),
    completeness: z.enum(['complete', 'partial']),
  });
const choicesOutput = output(
  z.object({
    kind: z.enum(['warehouse', 'reason']),
    name: z.string().nullable(),
  }),
);
const lookupOutput = output(
  z.object({
    order: external,
    number: z.string().nullable(),
    lumaCaseId: z.string().uuid(),
    createdAt: z.string().nullable(),
    warehouse: external.nullable(),
    lines: z.array(
      z.object({
        orderLine: external.nullable(),
        quantity: z.object({ amount: z.string(), unit: z.string() }),
        reason: external.nullable(),
      }),
    ),
  }),
);
const readDescriptor = {
  version: '0',
  minimumRisk: 'low',
  idempotency: 'none',
  retry: { maxAttempts: 3, initialDelayMs: 1000 },
} as const;
const marker = (caseId: string) => `luma-rc:${caseId}`;

function withheld(
  code: 'conflict' | 'permission_denied' | 'invalid_input',
): never {
  throw new ConnectorError({
    code,
    effect: 'none',
    retry: 'never',
    dispatch: 'not_dispatched',
  });
}

/** Creates or approves returns once; lost responses are reconciled by exact IDs or case markers, never replayed. */
export function createShopifyReturnCapabilities(
  options: ShopifyConnectorOptions,
): ConnectorConnection['capabilities'] {
  const request = createClient(options);
  const now = options.now ?? (() => new Date());
  const id = options.id ?? randomUUID;

  function check(context: InvocationContext) {
    if (
      context.tenant.tenantId !== options.tenantId ||
      context.connectionId !== options.connectionId ||
      context.provider !== 'shopify'
    )
      withheld('permission_denied');
  }

  async function emit<T extends ReturnOptionSnapshot | CreatedReturnSnapshot>(
    capability: 'returns.options.read' | 'returns.created.read',
    records: {
      resource: 'location' | 'return_reason' | 'return';
      externalId: string;
      data: T;
    }[],
    complete: boolean,
  ) {
    const observedAt = now().toISOString();
    const observations: Observation<T>[] = records.map((r) => ({
      id: id(),
      source: {
        tenantId: options.tenantId,
        connectionId: options.connectionId,
        provider: 'shopify',
        resource: r.resource,
        ...ref(r.externalId),
      },
      kind: 'snapshot',
      observedAt,
      sourceUpdatedAt: null,
      sourceRevision: null,
      adapterVersion,
      schemaVersion: 1,
      data: r.data,
    }));
    await options.recordObservations({
      tenantId: options.tenantId,
      connectionId: options.connectionId,
      apiVersion: API_VERSION,
      capability,
      observations,
    });

    return {
      items: observations,
      nextCursor: null,
      completeness: complete ? ('complete' as const) : ('partial' as const),
    };
  }

  async function readOrder(orderId: string) {
    gid('Order').parse(orderId);
    const raw = await request(
      `query LumaReturnActions($id: ID!) { node(id: $id) { ... on Order { id returns(first: 5) { nodes { ${returnFields} } pageInfo { hasNextPage } } } } }`,
      { id: orderId },
    );
    const order = parse(orderSchema, raw.node);
    if (order.id !== orderId) withheld('conflict');

    return order;
  }

  async function lookup(input: CapabilityInput<'returns.created.read'>) {
    const order = await readOrder(input.order.externalId);
    const candidates = order.returns.nodes.filter((r) =>
      input.requestedReturn
        ? r.id === input.requestedReturn.externalId
        : r.returnLineItems.nodes.some(
            (line) => line.returnReasonNote === marker(input.lumaCaseId),
          ),
    );
    const complete =
      candidates.every(
        (r) =>
          r.status === 'OPEN' &&
          (input.requestedReturn ||
            r.returnLineItems.nodes.every(
              (l) => l.returnReasonNote === marker(input.lumaCaseId),
            )),
      ) &&
      !order.returns.pageInfo.hasNextPage &&
      order.returns.nodes.every(
        (r) => !r.returnLineItems.pageInfo.hasNextPage,
      ) &&
      candidates.length <= input.limit;
    // REQUESTED is evidence of an outstanding request, never evidence that approval succeeded.
    const matches = candidates.filter(
      (r) =>
        r.status === 'OPEN' &&
        (input.requestedReturn ||
          r.returnLineItems.nodes.every(
            (l) => l.returnReasonNote === marker(input.lumaCaseId),
          )),
    );

    return emit<CreatedReturnSnapshot>(
      'returns.created.read',
      matches.slice(0, input.limit).map((r) => ({
        resource: 'return',
        externalId: r.id,
        data: {
          order: input.order,
          number: r.name,
          lumaCaseId: input.lumaCaseId,
          createdAt: r.createdAt,
          warehouse: null,
          lines: r.returnLineItems.nodes.map((l) => ({
            orderLine: ref(
              l.fulfillmentLineItem.lineItem.id,
              input.order.externalId,
            ),
            quantity: { amount: String(l.quantity), unit: 'each' },
            reason: null,
          })),
        },
      })),
      complete,
    );
  }

  const lookupHandler: CapabilityHandler<'returns.created.read'> = {
    descriptor: readDescriptor,
    parseInput: (v) => lookupInput.parse(v),
    parseOutput: (v) => lookupOutput.parse(v),
    async run(context, input) {
      check(context);

      return lookup(input);
    },
  };
  const choices: CapabilityHandler<'returns.options.read'> = {
    descriptor: readDescriptor,
    parseInput: (v) => pageInput.parse(v),
    parseOutput: (v) => choicesOutput.parse(v),
    async run(context) {
      check(context);

      return emit<ReturnOptionSnapshot>(
        'returns.options.read',
        [
          {
            resource: 'location',
            externalId: 'shopify',
            data: { kind: 'warehouse', name: 'Shopify return routing' },
          },
          ...reasons.map((r) => ({
            resource: 'return_reason' as const,
            externalId: r,
            data: {
              kind: 'reason' as const,
              name: r.replaceAll('_', ' ').toLowerCase(),
            },
          })),
        ],
        true,
      );
    },
  };
  const create: CapabilityHandler<'returns.create'> = {
    descriptor: {
      version: '0',
      minimumRisk: 'high',
      permission: 'shopify:returns.manage',
      idempotency: 'none',
      retry: { maxAttempts: 1, initialDelayMs: 0 },
    },
    parseInput: (v) => createInput.parse(v),
    parseOutput: (v) =>
      z
        .object({
          status: z.literal('accepted'),
          evidenceRefs: z.array(z.string().uuid()).length(1),
          providerRequestId: z.string().nullable(),
        })
        .strict()
        .parse(v),
    async run(context, input) {
      check(context);
      if (
        !context.idempotencyKey ||
        input.lines.some((l) => l.orderLine.scopeKey !== input.order.externalId)
      )
        withheld('invalid_input');
      const order = await readOrder(input.order.externalId);
      if (
        order.returns.pageInfo.hasNextPage ||
        order.returns.nodes.some((r) => r.returnLineItems.pageInfo.hasNextPage)
      )
        withheld('conflict');
      let variables: Record<string, unknown>;
      let mutation: string;
      if (input.requestedReturn) {
        const target = order.returns.nodes.find(
          (r) => r.id === input.requestedReturn!.externalId,
        );
        const actual = new Map<string, number>();
        for (const line of target?.returnLineItems.nodes ?? [])
          actual.set(
            line.fulfillmentLineItem.lineItem.id,
            (actual.get(line.fulfillmentLineItem.lineItem.id) ?? 0) +
              line.quantity,
          );
        if (
          !target ||
          target.status !== 'REQUESTED' ||
          actual.size !== input.lines.length ||
          input.lines.some(
            (l) =>
              actual.get(l.orderLine.externalId) !== Number(l.quantity.amount),
          )
        )
          withheld('conflict');
        mutation =
          'mutation LumaReturnApprove($input: ReturnApproveRequestInput!) { result: returnApproveRequest(input: $input) { return { id } userErrors { field message } } }';
        variables = { input: { id: target.id, notifyCustomer: false } };
      } else {
        if (
          order.returns.nodes.some((r) =>
            r.returnLineItems.nodes.some(
              (l) => l.returnReasonNote === marker(input.lumaCaseId),
            ),
          )
        )
          withheld('conflict');
        const raw = await request(
          `query LumaReturnable($id: ID!) { node(id: $id) { ... on Order { id fulfillments { status fulfillmentLineItems(first: 100) { nodes { id quantity lineItem { id } } pageInfo { hasNextPage } } } } } }`,
          { id: input.order.externalId },
        );
        const eligible = parse(
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
          eligible.id !== input.order.externalId ||
          eligible.fulfillments.some(
            (f) => f.fulfillmentLineItems.pageInfo.hasNextPage,
          )
        )
          withheld('conflict');
        const used = new Map<string, number>();
        for (const r of order.returns.nodes)
          if (!['DECLINED', 'CANCELED'].includes(r.status))
            for (const l of r.returnLineItems.nodes)
              used.set(
                l.fulfillmentLineItem.id,
                (used.get(l.fulfillmentLineItem.id) ?? 0) + l.quantity,
              );
        const lines = input.lines.map((l) => {
          const shipped = eligible.fulfillments
            .filter((f) => f.status === 'SUCCESS')
            .flatMap((f) => f.fulfillmentLineItems.nodes)
            .filter((f) => f.lineItem.id === l.orderLine.externalId);
          // Multiple fulfillment mappings need an explicit allocation preview, never an arbitrary pick.
          if (
            shipped.length !== 1 ||
            shipped[0]!.quantity - (used.get(shipped[0]!.id) ?? 0) <
              Number(l.quantity.amount)
          )
            withheld('conflict');

          return {
            fulfillmentLineItemId: shipped[0]!.id,
            quantity: Number(l.quantity.amount),
            returnReason: input.reason.externalId,
            returnReasonNote: marker(input.lumaCaseId),
          };
        });
        variables = {
          input: { orderId: input.order.externalId, returnLineItems: lines },
        };
        mutation =
          'mutation LumaReturnCreate($input: ReturnInput!) { result: returnCreate(returnInput: $input) { return { id } userErrors { field message } } }';
      }
      try {
        const raw = await request(mutation, variables);
        const receipt = parse(
          z.object({
            return: z.object({ id: gid('Return') }).nullable(),
            userErrors: z.array(
              z.object({
                field: z.array(z.string()).nullable(),
                message: z.string(),
              }),
            ),
          }),
          raw.result,
        );
        if (receipt.userErrors.length && !receipt.return) withheld('conflict');
        if (
          receipt.userErrors.length ||
          !receipt.return ||
          (input.requestedReturn &&
            receipt.return.id !== input.requestedReturn.externalId)
        )
          throw new Error('Ambiguous return receipt');
        // Record only allowlisted identities. Mutation acceptance is never verification.
        const evidence = await emit<CreatedReturnSnapshot>(
          'returns.created.read',
          [
            {
              resource: 'return',
              externalId: receipt.return.id,
              data: {
                order: input.order,
                lumaCaseId: input.lumaCaseId,
                number: null,
                createdAt: null,
                warehouse: null,
                lines: [],
              },
            },
          ],
          false,
        );

        return {
          status: 'accepted',
          evidenceRefs: [evidence.items[0]!.id],
          providerRequestId: null,
        };
      } catch (error) {
        if (
          error instanceof ConnectorError &&
          error.failure.dispatch === 'not_dispatched'
        )
          throw error;
        throw new ConnectorError({
          code: 'invalid_response',
          effect: 'unknown',
          dispatch: 'uncertain',
          retry: 'reconcile',
        });
      }
    },
  };

  return {
    'returns.options.read': choices,
    'returns.created.read': lookupHandler,
    'returns.create': create,
  };
}
