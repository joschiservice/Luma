import { z } from 'zod';
import type { ConnectorConnection } from '#modules/connectors/application/capabilities';
import { ConnectorError } from '#modules/connectors/domain/capabilities';

const externalId = z
  .object({ externalId: z.string().min(1), scopeKey: z.string() })
  .strict();
const decimal = z.string().regex(/^-?\d{1,14}(\.\d{1,6})?$/);
const readInput = z
  .object({
    limit: z.number().int().min(1).max(100),
    cursor: z.string().optional(),
    sku: externalId.optional(),
    location: externalId.optional(),
  })
  .strict();
const writeInput = z
  .object({
    sku: externalId,
    location: externalId,
    available: z.object({ amount: decimal, unit: z.literal('each') }).strict(),
    expectedRevision: z.string().min(1),
  })
  .strict();
const inventoryPage = z.object({
  items: z.array(
    z.object({
      id: z.string().uuid(),
      source: externalId.extend({
        tenantId: z.string(),
        connectionId: z.string(),
        provider: z.string(),
        resource: z.literal('sku'),
      }),
      kind: z.literal('snapshot'),
      observedAt: z.string().datetime(),
      sourceUpdatedAt: z.string().datetime().nullable(),
      sourceRevision: z.string(),
      adapterVersion: z.string(),
      schemaVersion: z.literal(1),
      data: z.object({
        sku: externalId,
        location: externalId,
        unit: z.literal('each'),
        onHand: decimal.nullable(),
        reserved: decimal.nullable(),
        available: decimal,
        availabilityBasis: z.literal('provider_reported'),
      }),
    }),
  ),
  nextCursor: z.null(),
  completeness: z.literal('complete'),
});
const receipt = z.object({
  status: z.literal('accepted'),
  evidenceRefs: z.array(z.string().uuid()).min(1),
  providerRequestId: z.string().nullable(),
});

/** In-memory conformance example, never registered as a production provider. */
export function createSampleConnector(options: {
  tenantId: string;
  connectionId: string;
  mechanism: 'api' | 'deterministic_browser';
  now(): Date;
  id(): string;
}): ConnectorConnection {
  const sku = { externalId: 'SKU/001', scopeKey: '' };
  const location = { externalId: 'Warehouse-A', scopeKey: '' };
  let available = '3.000000';
  let revision = 1;
  const receipts = new Map<
    string,
    { intent: string; receipt: z.infer<typeof receipt> }
  >();
  const matches = (
    a: z.infer<typeof externalId>,
    b: z.infer<typeof externalId>,
  ) => a.externalId === b.externalId && a.scopeKey === b.scopeKey;
  return {
    tenantId: options.tenantId,
    id: options.connectionId,
    provider: 'sample',
    status: 'active',
    adapterVersion: 'sample/0',
    mechanism: options.mechanism,
    executor: { kind: 'connector', id: 'sample/0' },
    capabilities: {
      'inventory.read': {
        descriptor: {
          version: '0',
          minimumRisk: 'low',
          idempotency: 'none',
          retry: { maxAttempts: 3, initialDelayMs: 500 },
        },
        parseInput(input) {
          const parsed = readInput.parse(input);
          return {
            limit: parsed.limit,
            ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
            ...(parsed.sku === undefined ? {} : { sku: parsed.sku }),
            ...(parsed.location === undefined
              ? {}
              : { location: parsed.location }),
          };
        },
        parseOutput: (output) => inventoryPage.parse(output),
        async run(context, input) {
          if (input.cursor !== undefined)
            throw new ConnectorError({
              code: 'invalid_input',
              effect: 'none',
              retry: 'never',
            });
          const included =
            (!input.sku || matches(input.sku, sku)) &&
            (!input.location || matches(input.location, location));
          return {
            items: included
              ? [
                  {
                    id: options.id(),
                    source: {
                      ...sku,
                      tenantId: context.tenant.tenantId,
                      connectionId: context.connectionId,
                      provider: context.provider,
                      resource: 'sku',
                    },
                    kind: 'snapshot',
                    observedAt: options.now().toISOString(),
                    sourceUpdatedAt: null,
                    sourceRevision: String(revision),
                    adapterVersion: 'sample/0',
                    schemaVersion: 1,
                    data: {
                      sku,
                      location,
                      unit: 'each',
                      onHand: null,
                      reserved: null,
                      available,
                      availabilityBasis: 'provider_reported',
                    },
                  },
                ]
              : [],
            nextCursor: null,
            completeness: 'complete',
          };
        },
      },
      'inventory.write': {
        descriptor: {
          version: '0',
          minimumRisk: 'medium',
          idempotency: 'provider_key',
          retry: { maxAttempts: 1, initialDelayMs: 0 },
        },
        parseInput: (input) => writeInput.parse(input),
        parseOutput: (output) => receipt.parse(output),
        async run(context, input) {
          if (!context.idempotencyKey)
            throw new ConnectorError({
              code: 'invalid_input',
              effect: 'none',
              retry: 'never',
            });
          const key = JSON.stringify([
            context.tenant.tenantId,
            context.connectionId,
            context.idempotencyKey,
          ]);
          const intent = JSON.stringify(writeInput.parse(input));
          const previous = receipts.get(key);
          if (previous) {
            if (previous.intent !== intent)
              throw new ConnectorError({
                code: 'conflict',
                effect: 'none',
                retry: 'never',
              });
            return structuredClone(previous.receipt);
          }
          if (!matches(input.sku, sku) || !matches(input.location, location))
            throw new ConnectorError({
              code: 'not_found',
              effect: 'none',
              retry: 'never',
            });
          if (input.expectedRevision !== String(revision))
            throw new ConnectorError({
              code: 'conflict',
              effect: 'none',
              retry: 'never',
            });
          available = input.available.amount;
          revision++;
          const result = {
            status: 'accepted' as const,
            evidenceRefs: [options.id()],
            providerRequestId: null,
          };
          receipts.set(key, { intent, receipt: result });
          return structuredClone(result);
        },
      },
    },
  };
}
