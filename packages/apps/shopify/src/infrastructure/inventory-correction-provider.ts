import { createHash, randomUUID } from 'node:crypto';

import { type CapabilityHandler, ConnectorError } from '@luma/connections';
import {
  createClient,
  parse,
  type ShopifyTransportOptions,
} from '@luma/connector-shopify';
import { z } from 'zod';

const gid = (kind: string) =>
  z.string().regex(new RegExp(`^gid://shopify/${kind}/[0-9]+$`));
const inputSchema = z
  .object({
    inventoryItemId: gid('InventoryItem'),
    locationId: gid('Location'),
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
    expectedAvailable: z.number().int().min(-2147483648).max(2147483647),
    available: z.number().int().min(0).max(2147483647),
  })
  .strict();
const nodeSchema = z.object({
  id: gid('InventoryItem'),
  tracked: z.boolean(),
  inventoryLevel: z
    .object({
      id: z.string(),
      updatedAt: z.string().datetime(),
      location: z.object({
        id: gid('Location'),
        name: z.string(),
        isActive: z.boolean(),
      }),
      quantities: z.array(
        z.object({ name: z.string(), quantity: z.number().int() }),
      ),
    })
    .nullable(),
});

export interface CorrectionEvidence {
  id: string;
  kind: 'observation' | 'acceptance';
  observedAt: string;
  document: unknown;
}

/** Dispatches a single available-quantity CAS with provider idempotency; reconciliation only reads. */
export function createInventoryCorrectionProvider(
  options: ShopifyTransportOptions & {
    tenantId: string;
    connectionId: string;
    record(evidence: CorrectionEvidence): Promise<void>;
    /** Rechecks source authority immediately before sending the mutation. */
    eligible?: () => Promise<boolean>;
    now?: () => Date;
  },
) {
  const request = createClient(options),
    now = options.now ?? (() => new Date());

  async function read(inventoryItemId: string, locationId: string) {
    gid('InventoryItem').parse(inventoryItemId);
    gid('Location').parse(locationId);
    const raw = await request(
      `query LumaInventoryCorrection($id: ID!, $locationId: ID!) {
      node(id: $id) { ... on InventoryItem { id tracked inventoryLevel(locationId: $locationId) {
        id updatedAt location { id name isActive } quantities(names: ["available"]) { name quantity }
      } } }
    }`,
      { id: inventoryItemId, locationId },
    );
    if (raw.node === null)
      throw new ConnectorError({
        code: 'not_found',
        effect: 'none',
        retry: 'never',
      });
    const node = parse(nodeSchema, raw.node),
      level = node.inventoryLevel;
    if (
      node.id !== inventoryItemId ||
      (level && level.location.id !== locationId)
    )
      throw new ConnectorError({
        code: 'invalid_response',
        effect: 'none',
        retry: 'never',
      });
    const snapshot = {
      id: randomUUID(),
      observedAt: now().toISOString(),
      targetRevision: createHash('sha256')
        .update(JSON.stringify(node))
        .digest('hex'),
      inventoryItemId,
      locationId,
      locationName: level?.location.name ?? locationId,
      tracked: node.tracked,
      complete:
        !!level &&
        level.location.isActive &&
        level.quantities.length === 1 &&
        level.quantities[0]?.name === 'available',
      available:
        level?.quantities.find((q) => q.name === 'available')?.quantity ?? null,
    };
    await options.record({
      id: snapshot.id,
      kind: 'observation',
      observedAt: snapshot.observedAt,
      document: snapshot,
    });

    return snapshot;
  }

  const handler: CapabilityHandler<'inventory.available.reconcile'> = {
    descriptor: {
      version: '0',
      minimumRisk: 'medium',
      idempotency: 'provider_key',
      retry: { maxAttempts: 1, initialDelayMs: 0 },
    },
    parseInput: (value) => inputSchema.parse(value),
    parseOutput: (value) =>
      z
        .object({
          status: z.literal('accepted'),
          evidenceRefs: z.array(z.string().uuid()).min(1),
          providerRequestId: z.string().nullable(),
        })
        .strict()
        .parse(value),
    async run(context, input) {
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
          dispatch: 'not_dispatched',
        });
      const current = await read(input.inventoryItemId, input.locationId);
      if (
        !current.complete ||
        !current.tracked ||
        current.targetRevision !== input.expectedRevision ||
        current.available !== input.expectedAvailable ||
        (options.eligible && !(await options.eligible()))
      )
        throw new ConnectorError({
          code: 'conflict',
          effect: 'none',
          retry: 'never',
          dispatch: 'not_dispatched',
        });
      try {
        const raw = await request(
          `mutation LumaInventoryCorrection($input: InventorySetQuantitiesInput!, $key: String!) {
          result: inventorySetQuantities(input: $input) @idempotent(key: $key) {
            inventoryAdjustmentGroup { reason referenceDocumentUri changes { name delta quantityAfterChange } }
            userErrors { field message code }
          }
        }`,
          {
            key: context.idempotencyKey,
            input: {
              name: 'available',
              reason: 'correction',
              referenceDocumentUri: `luma://inventory-corrections/${context.idempotencyKey}`,
              quantities: [
                {
                  inventoryItemId: input.inventoryItemId,
                  locationId: input.locationId,
                  changeFromQuantity: input.expectedAvailable,
                  quantity: input.available,
                },
              ],
            },
          },
        );
        const result = parse(
          z.object({
            inventoryAdjustmentGroup: z
              .object({
                reason: z.string(),
                referenceDocumentUri: z.string().nullable(),
                changes: z.array(
                  z.object({
                    name: z.string(),
                    delta: z.number().int(),
                    quantityAfterChange: z.number().int().nullable(),
                  }),
                ),
              })
              .nullable(),
            userErrors: z.array(
              z.object({
                field: z.array(z.string()).nullable(),
                message: z.string(),
                code: z.string().nullable(),
              }),
            ),
          }),
          raw.result,
        );
        if (result.userErrors.length && !result.inventoryAdjustmentGroup)
          throw new ConnectorError({
            code: 'conflict',
            effect: 'none',
            retry: 'never',
            dispatch: 'not_dispatched',
          });
        if (
          result.userErrors.length ||
          !result.inventoryAdjustmentGroup ||
          result.inventoryAdjustmentGroup.changes.length !== 1 ||
          result.inventoryAdjustmentGroup.changes[0]?.name !== 'available' ||
          result.inventoryAdjustmentGroup.changes[0].quantityAfterChange !==
            input.available ||
          result.inventoryAdjustmentGroup.changes[0].delta !==
            input.available - input.expectedAvailable
        )
          throw new Error('Ambiguous inventory acceptance');
        const id = randomUUID();
        await options.record({
          id,
          kind: 'acceptance',
          observedAt: now().toISOString(),
          document: {
            inventoryItemId: input.inventoryItemId,
            locationId: input.locationId,
            expectedAvailable: input.expectedAvailable,
            available: input.available,
            idempotencyKey: context.idempotencyKey,
          },
        });

        return {
          status: 'accepted',
          evidenceRefs: [id],
          providerRequestId: null,
        };
      } catch (error) {
        if (
          error instanceof ConnectorError &&
          error.failure.dispatch === 'not_dispatched'
        )
          throw error;
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

  return { read, capabilities: { 'inventory.available.reconcile': handler } };
}
