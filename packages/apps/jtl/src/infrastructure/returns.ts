import { createHash, randomUUID } from 'node:crypto';

import {
  type CapabilityHandler,
  type CapabilityInput,
  type CapabilityOutput,
  type ConnectorConnection,
  ConnectorError,
  type ConnectorFailure,
  type CreatedReturnSnapshot,
  type ExternalId,
  type InvocationContext,
  type Observation,
  type ReturnOptionSnapshot,
  type SourceIdentity,
} from '@luma/connections';
import {
  API_VERSION,
  createClient,
  createPayloadCapture,
  fail,
  parse,
} from '@luma/connector-jtl';
import { z } from 'zod';

import { jtlPermissions } from '../domain/permissions.js';
import type { JtlConnectorOptions } from './adapter.js';
import { adapterVersion, outputs } from './outputs.js';
import { stableUuid } from './purchase-orders.js';
import * as s from './schemas.js';

type ReadKind = 'returns.options.read' | 'returns.created.read';

type ReturnRow = z.infer<typeof s.returnRow>;

const ref = (id: string, scopeKey = ''): ExternalId => ({
  externalId: id,
  scopeKey,
});

// Blank or oversized source text is treated as not provided rather than truncated.
const text = (value: string | null | undefined) => {
  const trimmed = value?.trim();

  return trimmed && trimmed.length <= 512 ? trimmed : null;
};

// Bounds the warehouse overview read for return options.
const WAREHOUSE_PAGES = 10;
const WAREHOUSE_PAGE_SIZE = 100;

// Bounds the return pages one created-return lookup may scan for an order.
const CREATED_SCAN_PAGES = 5;
const CREATED_SCAN_PAGE_SIZE = 100;

// JTL language codes appear as ISO 639-1 or 639-2 codes depending on the installation.
const ENGLISH = new Set(['en', 'eng']);
const GERMAN = new Set(['de', 'ger', 'deu']);

/**
 * Marks a JTL return so Luma can find it again. It is stored in `externalNumber`, which JTL
 * accepts only at creation and never changes afterwards.
 */
export const lumaReturnMarker = (caseId: string) => `luma-rc:${caseId}`;

/**
 * Names the accepted creation of one JTL return as a stable UUID, because execution evidence
 * references are UUIDs. The return itself is found again by an independent read.
 */
export function returnAcceptanceId(
  tenantId: string,
  connectionId: string,
  returnId: string,
) {
  return stableUuid(['jtl', 'return', tenantId, connectionId, returnId]);
}

/** Picks the English reason name, else German, else the first translation. */
function reasonName(reason: z.infer<typeof s.returnReason>) {
  const translations = reason.translations ?? [];
  const language = (codes: Set<string>) =>
    translations.find((value) =>
      codes.has(value.languageIso.trim().toLowerCase()),
    );
  const found =
    language(ENGLISH) ?? language(GERMAN) ?? translations[0] ?? null;

  return text(found?.name);
}

function notDispatched(
  code: ConnectorFailure['code'],
  failure?: ConnectorFailure,
): never {
  throw new ConnectorError({
    ...(failure ?? { code, retry: 'never' }),
    code,
    effect: 'none',
    dispatch: 'not_dispatched',
  });
}

/**
 * Return options, created-return lookup and return creation. Creation is a high-risk,
 * provider-keyed write: it checks the order and its lines, refuses when JTL already holds a
 * return marked for the same Luma return case, and reports any response after dispatch that
 * does not establish the outcome as uncertain. JTL returns are verification evidence only;
 * they are not imported as canonical returns.
 */
export function createJtlReturnCapabilities(
  options: JtlConnectorOptions,
): ConnectorConnection['capabilities'] {
  const client = createClient(options);
  const now = options.now ?? (() => new Date());
  const nextId = options.id ?? randomUUID;
  const units = { stk: 'each', Stück: 'each', each: 'each', ...options.units };

  function check(context: InvocationContext) {
    if (
      context.tenant.tenantId !== options.tenantId ||
      context.connectionId !== options.connectionId ||
      context.provider !== 'jtl'
    )
      fail('unavailable');
  }

  /** Collects allowlisted payloads and observations for one capability call. */
  function session(capability: ReadKind) {
    const observedAt = now().toISOString();
    const payloads = createPayloadCapture(options.rawRetentionMs, now);
    const capture = payloads.capture;
    const observations: Observation<unknown>[] = [];

    async function page<T extends z.ZodTypeAny>(
      path: string,
      schema: T,
      number: number,
      size: number,
      query: Record<string, string> = {},
    ) {
      const result = capture(
        s.page(schema),
        await client.request(path, {
          ...query,
          pageNumber: String(number),
          pageSize: String(size),
        }),
      );
      const remaining = Math.max(0, result.totalItems - (number - 1) * size);
      const hasNext = number * size < result.totalItems;
      if (
        result.pageNumber !== number ||
        result.pageSize !== size ||
        result.items.length !== Math.min(size, remaining) ||
        (result.hasNextPage !== undefined && result.hasNextPage !== hasNext)
      )
        fail('invalid_response');

      return { items: result.items as z.infer<T>[], hasNext };
    }

    function emit(
      resource: SourceIdentity['resource'],
      id: string,
      data: ReturnOptionSnapshot | CreatedReturnSnapshot,
    ) {
      observations.push({
        id: nextId(),
        source: {
          ...ref(id),
          tenantId: options.tenantId,
          connectionId: options.connectionId,
          provider: 'jtl',
          resource,
        },
        kind: 'snapshot',
        observedAt,
        sourceUpdatedAt: null,
        sourceRevision: null,
        adapterVersion,
        schemaVersion: 1,
        data,
      });
    }

    async function finish<K extends ReadKind>(
      kind: K,
      completeness: 'complete' | 'partial',
    ): Promise<CapabilityOutput<K>> {
      const keys = observations.map((value) =>
        JSON.stringify([value.source.resource, value.source.externalId]),
      );
      if (new Set(keys).size !== keys.length) fail('invalid_response');
      const result = parse<unknown>(outputs[kind], {
        items: observations,
        nextCursor: null,
        completeness,
      }) as CapabilityOutput<K>;
      await options.recordObservations({
        tenantId: options.tenantId,
        connectionId: options.connectionId,
        apiVersion: API_VERSION,
        capability,
        observations: result.items,
        ...payloads.raw(),
      });

      return result;
    }

    return { capture, page, emit, finish };
  }

  const readDescriptor = {
    version: '0',
    minimumRisk: 'low',
    idempotency: 'none',
    retry: { maxAttempts: 3, initialDelayMs: 1000 },
  } as const;

  /** Emits every active warehouse and every return reason; `limit` does not page them. */
  async function readOptions() {
    const current = session('returns.options.read');
    const warehouses: z.infer<typeof s.warehouse>[] = [];
    let complete = false;
    for (let number = 1; number <= WAREHOUSE_PAGES; number++) {
      const result = await current.page(
        'warehouses',
        s.warehouse,
        number,
        WAREHOUSE_PAGE_SIZE,
      );
      warehouses.push(...result.items);
      if (!result.hasNext) {
        complete = true;
        break;
      }
    }
    const reasons = current.capture(
      z.array(s.returnReason),
      await client.request('return-reasons'),
    );
    for (const warehouse of warehouses)
      // An inactive warehouse cannot receive a return.
      if (warehouse.active !== false)
        current.emit('location', warehouse.id, {
          kind: 'warehouse',
          name: text(warehouse.name),
        });
    for (const reason of reasons)
      current.emit('return_reason', reason.id, {
        kind: 'reason',
        name: reasonName(reason),
      });

    return current.finish(
      'returns.options.read',
      complete ? 'complete' : 'partial',
    );
  }

  /** Finds returns of the order marked for the Luma return case, within a bounded scan. */
  async function readCreated(input: CapabilityInput<'returns.created.read'>) {
    const current = session('returns.created.read');
    const order = input.order.externalId;
    const marker = lumaReturnMarker(input.lumaCaseId);
    const matches: ReturnRow[] = [];
    let complete = false;
    for (let number = 1; number <= CREATED_SCAN_PAGES; number++) {
      const result = await current.page(
        'returns',
        s.returnRow,
        number,
        CREATED_SCAN_PAGE_SIZE,
        { salesOrderId: order },
      );
      for (const row of result.items) {
        if (row.salesOrderId !== order) fail('invalid_response');
        if (row.externalNumber === marker) matches.push(row);
      }
      if (!result.hasNext) {
        complete = true;
        break;
      }
    }
    for (const row of matches.slice(0, input.limit)) {
      const lines = current.capture(
        z.array(s.returnLine),
        await client.request(`returns/${row.id}/line-items`),
      );
      if (
        lines.some((line) => line.returnId !== row.id) ||
        new Set(lines.map((line) => line.id)).size !== lines.length
      )
        fail('invalid_response');
      current.emit('return', row.id, {
        order: ref(order),
        number: text(row.number),
        lumaCaseId: input.lumaCaseId,
        createdAt: row.returnDate ?? null,
        warehouse: row.warehouseId ? ref(row.warehouseId) : null,
        lines: lines.map((line) => ({
          // Sales-order lines are scoped by their order, as `orders.read` reports them.
          orderLine: line.salesOrderLineItemId
            ? ref(line.salesOrderLineItemId, order)
            : null,
          quantity: { amount: line.quantity, unit: 'each' },
          reason: line.returnReasonId ? ref(line.returnReasonId) : null,
        })),
      });
    }

    return current.finish(
      'returns.created.read',
      complete && matches.length <= input.limit ? 'complete' : 'partial',
    );
  }

  const returnOptions: CapabilityHandler<'returns.options.read'> = {
    descriptor: readDescriptor,
    parseInput: (value) =>
      s.returnInputs['returns.options.read'].parse(
        value,
      ) as CapabilityInput<'returns.options.read'>,
    parseOutput: (value) =>
      outputs['returns.options.read'].parse(
        value,
      ) as CapabilityOutput<'returns.options.read'>,
    async run(context) {
      check(context);

      return readOptions();
    },
  };

  const created: CapabilityHandler<'returns.created.read'> = {
    descriptor: readDescriptor,
    parseInput: (value) =>
      s.returnInputs['returns.created.read'].parse(
        value,
      ) as CapabilityInput<'returns.created.read'>,
    parseOutput: (value) =>
      outputs['returns.created.read'].parse(
        value,
      ) as CapabilityOutput<'returns.created.read'>,
    async run(context, input) {
      check(context);

      return readCreated(input);
    },
  };

  /** Reads the order's company and lines and checks every requested line against them. */
  async function prepare(input: CapabilityInput<'returns.create'>) {
    const orderId = input.order.externalId;
    const order = parse(
      s.salesOrderCompany,
      await client.request(`sales-orders/${orderId}`),
    );
    if (order.id !== orderId) fail('invalid_response');
    if (order.isCancelled) notDispatched('conflict');
    const lines = parse(
      z.array(s.orderLine),
      await client.request(`sales-orders/${orderId}/line-items`),
    );
    if (
      new Set(lines.map((line) => line.id)).size !== lines.length ||
      lines.some((line) => line.salesOrderId !== orderId)
    )
      fail('invalid_response');
    for (const requested of input.lines) {
      const line = lines.find(
        (value) => value.id === requested.orderLine.externalId,
      );
      if (!line) notDispatched('invalid_input');
      // Only countable lines can take a quantity in `each`, and never more than was ordered.
      if (
        (units as Record<string, string>)[line.salesUnit] !== 'each' ||
        Number(requested.quantity.amount) > Number(line.quantity)
      )
        notDispatched('conflict');
    }

    return order;
  }

  const create: CapabilityHandler<'returns.create'> = {
    descriptor: {
      version: '0',
      minimumRisk: 'high',
      permission: jtlPermissions.returns,
      idempotency: 'provider_key',
      retry: { maxAttempts: 1, initialDelayMs: 0 },
    },
    parseInput: (value) => s.returnInputs['returns.create'].parse(value),
    parseOutput: (value) =>
      z
        .object({
          status: z.literal('accepted'),
          evidenceRefs: z.array(z.string().min(1)).length(1),
          providerRequestId: z.string().nullable(),
        })
        .strict()
        .parse(value),
    async run(context, value) {
      if (
        context.tenant.tenantId !== options.tenantId ||
        context.connectionId !== options.connectionId ||
        context.provider !== 'jtl'
      )
        notDispatched('unavailable');
      if (!context.idempotencyKey?.trim()) notDispatched('invalid_input');
      const parsed = s.returnInputs['returns.create'].safeParse(value);
      if (!parsed.success) notDispatched('invalid_input');
      const input = parsed.data;

      let companyId: string;
      try {
        companyId = (await prepare(input)).companyId;
        const existing = await readCreated({
          limit: 25,
          order: input.order,
          lumaCaseId: input.lumaCaseId,
        });
        // An existing return, or a scan that cannot rule one out, must be reconciled instead.
        if (existing.items.length || existing.completeness !== 'complete')
          notDispatched('conflict');
      } catch (error) {
        if (error instanceof ConnectorError)
          notDispatched(error.failure.code, error.failure);
        notDispatched('internal');
      }

      // Execution binds this logical key to immutable intent. Do not derive a new key from changed parameters.
      const key = createHash('sha256')
        .update(
          JSON.stringify([
            options.tenantId,
            options.connectionId,
            client.binding,
            'returns.create',
            context.idempotencyKey,
          ]),
        )
        .digest('hex');
      let providerRequestId: string | null = null;
      const response = await client.request(
        'returns',
        {},
        {
          method: 'POST',
          // No customer text is sent; `credit: false` keeps JTL from booking a credit.
          body: {
            companyId,
            salesOrderId: input.order.externalId,
            warehouseId: input.warehouse.externalId,
            externalNumber: lumaReturnMarker(input.lumaCaseId),
            internalComment: 'Created by Luma',
            items: input.lines.map((line) => ({
              salesOrderLineItemId: line.orderLine.externalId,
              quantity: Number(line.quantity.amount),
              returnReasonId: input.reason.externalId,
              credit: false,
            })),
          },
          idempotencyKey: key,
          receipt: (id) => {
            providerRequestId = id;
          },
        },
      );
      const accepted = s.returnCreated.safeParse(response);
      if (!accepted.success)
        throw new ConnectorError({
          code: 'invalid_response',
          ...(providerRequestId ? { providerRequestId } : {}),
          effect: 'unknown',
          retry: 'reconcile',
        });

      return {
        status: 'accepted',
        evidenceRefs: [
          returnAcceptanceId(
            options.tenantId,
            options.connectionId,
            accepted.data.id,
          ),
        ],
        providerRequestId,
      };
    },
  };

  return {
    'returns.options.read': returnOptions,
    'returns.created.read': created,
    ...(options.returnActions ? { 'returns.create': create } : {}),
  };
}
