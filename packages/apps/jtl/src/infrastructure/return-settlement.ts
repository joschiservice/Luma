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
import { API_VERSION, createClient, parse } from '@luma/connector-jtl';
import { fromUnits, toUnits } from '@luma/orders';
import { z } from 'zod';

import type { JtlConnectorOptions } from './adapter.js';
import { adapterVersion } from './outputs.js';
import * as s from './schemas.js';

const row = z.object({
  itemId: s.id,
  warehouseId: s.id,
  quantity: s.warehouseStock.shape.totalQuantity,
  changedDate: z.string().datetime(),
  comment: z
    .string()
    .nullable()
    .transform((v) => v?.match(/^luma-rs:[0-9a-f-]{36}$/)?.[0] ?? null),
});

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

/** Adds inspected resale units once and reconciles the exact stock-change marker plus warehouse total. */
export function createJtlSettlementCapabilities(
  options: JtlConnectorOptions,
): ConnectorConnection['capabilities'] {
  const client = createClient(options),
    now = options.now ?? (() => new Date()),
    id = options.id ?? randomUUID;

  function check(context: InvocationContext) {
    if (
      context.tenant.tenantId !== options.tenantId ||
      context.connectionId !== options.connectionId ||
      context.provider !== 'jtl'
    )
      withheld();
  }

  async function evidence(
    capability:
      'returns.settlement.quote.read' | 'returns.settlement.proof.read',
    input: Extract<ReturnSettlementPlan, { kind: 'restock' }>,
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
            provider: 'jtl',
            resource: 'sku',
            externalId: input.item.externalId,
            scopeKey: input.warehouse.externalId,
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

  async function stock(
    input: Extract<ReturnSettlementQuote, { kind: 'restock' }>,
  ) {
    s.id.parse(input.item.externalId);
    s.id.parse(input.warehouse.externalId);
    if (input.item.scopeKey || input.warehouse.scopeKey) withheld();
    const item = parse(
      s.item,
      await client.request(
        `items/${encodeURIComponent(input.item.externalId)}`,
      ),
    );
    const warehouse = parse(
      s.warehouse,
      await client.request(
        `warehouses/${encodeURIComponent(input.warehouse.externalId)}`,
      ),
    );
    if (
      item.id !== input.item.externalId ||
      warehouse.id !== input.warehouse.externalId ||
      warehouse.active === false ||
      !item.isInventoryManagementActive
    )
      withheld();
    const current = parse(
      s.warehouseStock,
      await client.request(
        `warehouses/${encodeURIComponent(input.warehouse.externalId)}/items/${encodeURIComponent(input.item.externalId)}/stocks`,
      ),
    );
    if (current.totalQuantity == null) withheld();

    return current.totalQuantity;
  }

  async function changes(input: ReturnSettlementWrite) {
    if (input.plan.kind !== 'restock') withheld();
    const plan = input.plan;
    const records: z.infer<typeof row>[] = [];
    let complete = false;
    for (let number = 1; number <= 5; number++) {
      const page = parse(
        s.page(row),
        await client.request('stocks/changes', {
          itemId: plan.item.externalId,
          pageNumber: String(number),
          pageSize: '100',
        }),
      );
      if (
        page.pageNumber !== number ||
        page.pageSize !== 100 ||
        page.items.length !==
          Math.min(100, Math.max(0, page.totalItems - (number - 1) * 100)) ||
        page.items.some((r) => r.itemId !== plan.item.externalId)
      )
        withheld();
      records.push(
        ...page.items.filter(
          (r) => r.comment === `luma-rs:${input.operationId}`,
        ),
      );
      if (number * 100 >= page.totalItems) {
        complete = true;
        break;
      }
    }

    return { records, complete };
  }

  const quote: CapabilityHandler<'returns.settlement.quote.read'> = {
    descriptor: readDescriptor,
    parseInput: (v) => returnSettlementQuoteSchema.parse(v),
    parseOutput: (v) => returnSettlementQuotedSchema.parse(v),
    async run(context, input) {
      check(context);
      if (input.kind !== 'restock') withheld();
      const observedAt = now().toISOString();
      const plan = { ...input, baselineOnHand: await stock(input) };

      return {
        plan,
        observedAt,
        evidenceRefs: await evidence(
          'returns.settlement.quote.read',
          plan,
          plan,
          observedAt,
        ),
      };
    },
  };
  const proof: CapabilityHandler<'returns.settlement.proof.read'> = {
    descriptor: readDescriptor,
    parseInput: (v) => returnSettlementWriteSchema.parse(v),
    parseOutput: (v) => returnSettlementProofSchema.parse(v),
    async run(context, input) {
      check(context);
      if (input.plan.kind !== 'restock') withheld();
      const plan = input.plan,
        observedAt = now().toISOString();
      const found = await changes(input),
        onHand = await stock(plan);
      const exact =
        found.complete &&
        found.records.length === 1 &&
        found.records[0]!.warehouseId === plan.warehouse.externalId &&
        toUnits(found.records[0]!.quantity) ===
          BigInt(plan.quantity) * 1_000_000n;
      // Concurrent unrelated warehouse movements leave the total inconclusive; they never permit another write.
      const outcome =
        exact &&
        toUnits(onHand) ===
          toUnits(plan.baselineOnHand) + BigInt(plan.quantity) * 1_000_000n
          ? ('passed' as const)
          : ('inconclusive' as const);

      return {
        outcome,
        payment: null,
        observedAt,
        evidenceRefs: await evidence(
          'returns.settlement.proof.read',
          plan,
          {
            operationId: input.operationId,
            changes: found.records,
            onHand,
            complete: found.complete,
          },
          observedAt,
        ),
      };
    },
  };
  const write: CapabilityHandler<'returns.restock'> = {
    descriptor: {
      version: '0',
      minimumRisk: 'high',
      permission: 'jtl:returns.restock',
      idempotency: 'none',
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
      if (input.plan.kind !== 'restock' || !context.idempotencyKey) withheld();
      const plan = input.plan;
      try {
        const found = await changes(input);
        if (
          !found.complete ||
          found.records.length ||
          toUnits(await stock(plan)) !== toUnits(plan.baselineOnHand)
        )
          withheld();
      } catch (error) {
        if (error instanceof ConnectorError)
          throw new ConnectorError({
            ...error.failure,
            effect: 'none',
            dispatch: 'not_dispatched',
          });
        throw error;
      }
      let providerRequestId: string | null = null;
      const raw = await client.request(
        'stocks',
        { disableAutomaticWorkflows: 'true' },
        {
          method: 'POST',
          idempotencyKey: context.idempotencyKey,
          body: {
            itemId: plan.item.externalId,
            warehouseId: plan.warehouse.externalId,
            quantity: plan.quantity,
            comment: `luma-rs:${input.operationId}`,
          },
          receipt: (value) => {
            providerRequestId = value;
          },
        },
      );
      const accepted = z
        .object({
          itemId: s.id,
          warehouseId: s.id,
          quantityTotal: s.warehouseStock.shape.totalQuantity,
        })
        .safeParse(raw);
      if (
        !accepted.success ||
        accepted.data.itemId !== plan.item.externalId ||
        accepted.data.warehouseId !== plan.warehouse.externalId
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
          plan,
          {
            operationId: input.operationId,
            accepted: true,
            quantity: fromUnits(BigInt(plan.quantity) * 1_000_000n),
          },
          now().toISOString(),
        ),
        providerRequestId,
      };
    },
  };

  return {
    'returns.settlement.quote.read': quote,
    'returns.settlement.proof.read': proof,
    ...(options.settlementActions ? { 'returns.restock': write } : {}),
  };
}
