import { createHash, randomUUID } from 'node:crypto';

import { type CapabilityHandler, ConnectorError } from '@luma/connections';
import {
  createClient,
  parse,
  type ShopifyTransportOptions,
} from '@luma/connector-shopify';
import { z } from 'zod';

import {
  acceptanceProvenance,
  beforeDispatch,
  type ReadProvenance,
  settledDispatch,
  sourceTime,
  storeAcceptance,
} from './evidence-provenance.js';
import {
  type InventoryWriteReceipt,
  readInventoryWriteProofs,
} from './inventory-write-attribution.js';

/** Identifies the normalization of the correction read; corrections dispatch under it too. */
export const inventoryCorrectionAdapterVersion = 'shopify-inventory/1';

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
  variant: z
    .object({
      inventoryPolicy: z.enum(['DENY', 'CONTINUE']).optional(),
      sku: z.string().nullable().optional(),
      product: z
        .object({
          status: z.string(),
          tags: z.array(z.string()),
          collections: z
            .object({
              nodes: z.array(z.object({ id: z.string() })),
              pageInfo: z.object({ hasNextPage: z.boolean() }),
            })
            .optional(),
        })
        .optional(),
      requiresComponents: z.boolean(),
      productVariantComponents: z.object({
        nodes: z.array(z.object({ id: gid('ProductVariantComponent') })),
      }),
    })
    .nullable(),
  inventoryLevel: z
    .object({
      id: z.string(),
      isActive: z.boolean(),
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
    /** Accepted receipts from this tenant and connection; failed proof leaves authorship unknown. */
    receipts?(
      inventoryItemId: string,
      locationId: string,
    ): Promise<InventoryWriteReceipt[]>;
    /** Attribution is bound by the trusted incident owner, never by client input. */
    holdId?: string;
    /** Only collection exclusions need this bounded, more expensive product membership read. */
    includeCollections?: boolean;
    /** Rechecks source authority immediately before sending the mutation. */
    eligible?: () => Promise<boolean>;
    /** Native publication stores quantity without changing inactive inventory eligibility. */
    allowInactiveStorage?: boolean;
    /** Holds the owner pool stable only during an admitted effect. */
    dispatchFence?: <T>(operation: () => Promise<T>) => Promise<T>;
    /** Retains channel semantics before a possible mutation; never called by preview or observe-only. */
    beforeDispatch?: () => Promise<void>;
    now?: () => Date;
  },
) {
  const request = createClient(options),
    now = options.now ?? (() => new Date());

  async function read(inventoryItemId: string, locationId: string) {
    gid('InventoryItem').parse(inventoryItemId);
    gid('Location').parse(locationId);
    const raw = await request(
      `query LumaInventoryCorrection($id: ID!, $locationId: ID!, $collections: Boolean!) {
      node(id: $id) { ... on InventoryItem { id tracked variant { inventoryPolicy sku product { status tags collections(first: 250) @include(if: $collections) { nodes { id } pageInfo { hasNextPage } } } requiresComponents productVariantComponents(first: 1) { nodes { id } } } inventoryLevel(locationId: $locationId) {
        id updatedAt isActive location { id name isActive } quantities(names: ["available"]) { name quantity }
      } } }
    }`,
      {
        id: inventoryItemId,
        locationId,
        collections: options.includeCollections ?? false,
      },
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
    const observedAt = now().toISOString();
    const receipts = options.receipts
      ? await options.receipts(inventoryItemId, locationId)
      : [];
    const proof = (
      await readInventoryWriteProofs(
        request,
        receipts.filter(
          (receipt) =>
            receipt.inventoryItemId === inventoryItemId &&
            receipt.locationId === locationId &&
            Date.parse(receipt.observedAt) <= Date.parse(observedAt),
        ),
      )
    )[0];
    const available =
      level?.quantities.find((q) => q.name === 'available')?.quantity ?? null;
    const snapshot = {
      id: randomUUID(),
      observedAt,
      targetRevision: createHash('sha256')
        .update(
          JSON.stringify({
            ...node,
            variant: node.variant
              ? {
                  ...node.variant,
                  product: node.variant.product
                    ? { ...node.variant.product, collections: undefined }
                    : undefined,
                }
              : null,
          }),
        )
        .digest('hex'),
      inventoryItemId,
      locationId,
      locationName: level?.location.name ?? locationId,
      tracked: node.tracked,
      itemActive: level?.isActive ?? null,
      locationActive: level?.location.isActive ?? null,
      inventoryPolicy: node.variant?.inventoryPolicy ?? null,
      protectionMetadata: node.variant?.product
        ? {
            sku: node.variant.sku ?? null,
            tags: node.variant.product.tags,
            collections:
              node.variant.product.collections?.nodes.map((c) => c.id) ?? [],
            complete:
              !options.includeCollections ||
              node.variant.product.collections?.pageInfo.hasNextPage === false,
            active: node.variant.product.status === 'ACTIVE',
          }
        : null,
      bundleParent: node.variant
        ? node.variant.requiresComponents ||
          node.variant.productVariantComponents.nodes.length > 0
        : null,
      complete:
        node.variant !== null &&
        !(
          node.variant &&
          (node.variant.requiresComponents ||
            node.variant.productVariantComponents.nodes.length > 0)
        ) &&
        !!level &&
        (options.allowInactiveStorage ||
          (level.location.isActive && level.isActive)) &&
        level.quantities.length === 1 &&
        level.quantities[0]?.name === 'available',
      available,
      writeAttribution: proof
        ? {
            evidenceId: proof.evidenceId,
            adjustmentId: proof.adjustmentId,
            referenceDocumentUri: proof.referenceDocumentUri,
            available: String(proof.available),
            quantityMatches:
              available === null ? null : available === proof.available,
          }
        : null,
    };
    // Only the optional collection membership is paged; a cut-short page leaves the read partial.
    const provenance: ReadProvenance = {
      adapterVersion: inventoryCorrectionAdapterVersion,
      completeness:
        options.includeCollections &&
        node.variant?.product &&
        node.variant.product.collections?.pageInfo.hasNextPage !== false
          ? 'partial'
          : 'complete',
      sourceRevision: snapshot.targetRevision,
      sourceUpdatedAt: sourceTime(level?.updatedAt),
      record: level
        ? { resource: 'inventory_level', externalId: level.id }
        : { resource: 'inventory_item', externalId: inventoryItemId },
    };
    await options.record({
      id: snapshot.id,
      kind: 'observation',
      observedAt: snapshot.observedAt,
      document: { ...snapshot, ...provenance },
    });

    return snapshot;
  }

  const handler: CapabilityHandler<'inventory.available.reconcile'> = {
    descriptor: {
      version: '0',
      minimumRisk: 'medium',
      permission: 'shopify:inventory_corrections.apply',
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
      const current = await beforeDispatch(() =>
        read(input.inventoryItemId, input.locationId),
      );
      if (
        !current.complete ||
        !current.tracked ||
        (!!options.holdId && current.inventoryPolicy !== 'DENY') ||
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
      await options.beforeDispatch?.();
      try {
        const referenceDocumentUri = options.holdId
          ? `luma://inventory-holds/${options.holdId}`
          : `luma://inventory-corrections/${context.idempotencyKey}`;
        const raw = await request(
          `mutation LumaInventoryCorrection($input: InventorySetQuantitiesInput!, $key: String!) {
          result: inventorySetQuantities(input: $input) @idempotent(key: $key) {
            inventoryAdjustmentGroup { id reason referenceDocumentUri changes { name delta quantityAfterChange } }
            userErrors { field message code }
          }
        }`,
          {
            key: context.idempotencyKey,
            input: {
              name: 'available',
              reason: 'correction',
              referenceDocumentUri,
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
                id: gid('InventoryAdjustmentGroup'),
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
          result.inventoryAdjustmentGroup.reason !== 'correction' ||
          result.inventoryAdjustmentGroup.referenceDocumentUri !==
            referenceDocumentUri ||
          result.inventoryAdjustmentGroup.changes.length !== 1 ||
          result.inventoryAdjustmentGroup.changes[0]?.name !== 'available' ||
          result.inventoryAdjustmentGroup.changes[0].quantityAfterChange !==
            input.available ||
          result.inventoryAdjustmentGroup.changes[0].delta !==
            input.available - input.expectedAvailable
        )
          throw new Error('Ambiguous inventory acceptance');
        const id = randomUUID();
        const adjustmentId = result.inventoryAdjustmentGroup.id;
        await storeAcceptance(() =>
          options.record({
            id,
            kind: 'acceptance',
            observedAt: now().toISOString(),
            document: {
              inventoryItemId: input.inventoryItemId,
              locationId: input.locationId,
              expectedAvailable: input.expectedAvailable,
              available: input.available,
              referenceDocumentUri,
              adjustmentId,
              ...acceptanceProvenance(context, [
                {
                  resource: 'inventory_adjustment_group',
                  externalId: adjustmentId,
                },
              ]),
            },
          }),
        );

        return {
          status: 'accepted',
          evidenceRefs: [id],
          providerRequestId: null,
        };
      } catch (error) {
        if (settledDispatch(error)) throw error;
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

  if (options.dispatchFence) {
    const run = handler.run;
    handler.run = (context, input) =>
      options.dispatchFence!(() => run(context, input));
  }

  return { read, capabilities: { 'inventory.available.reconcile': handler } };
}
