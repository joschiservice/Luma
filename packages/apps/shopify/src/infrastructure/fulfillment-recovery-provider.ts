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
import { z } from 'zod';

import {
  recoveryBlocker,
  type RecoveryCapability,
  recoveryChoice,
  type RecoverySnapshot,
} from '../domain/fulfillment-recovery.js';
import {
  acceptanceProvenance,
  type ReadProvenance,
  settledDispatch,
  sourceTime,
  storeAcceptance,
} from './evidence-provenance.js';

/** Identifies the normalization of fulfillment order reads; recoveries dispatch under it too. */
export const fulfillmentRecoveryAdapterVersion = 'shopify-fulfillment/1';

const id = (kind: string) =>
  z.string().regex(new RegExp(`^gid://shopify/${kind}/[0-9]+$`));
const nodeSchema = z.object({
  id: id('FulfillmentOrder'),
  updatedAt: z.string().datetime(),
  status: z.string(),
  requestStatus: z.string(),
  order: z.object({ id: id('Order') }),
  assignedLocation: z.object({
    name: z.string(),
    location: z.object({ id: id('Location') }).nullable(),
  }),
  supportedActions: z.array(z.object({ action: z.string() })),
  fulfillmentHolds: z.array(
    z.object({
      id: id('FulfillmentHold'),
      reason: z.string(),
      heldByRequestingApp: z.boolean(),
    }),
  ),
  lineItems: z.object({
    nodes: z.array(
      z.object({
        lineItem: z.object({ id: id('LineItem') }),
        remainingQuantity: z.number().int().nonnegative(),
        totalQuantity: z.number().int().nonnegative(),
      }),
    ),
    pageInfo: z.object({ hasNextPage: z.boolean() }),
  }),
  locationsForMove: z
    .object({
      nodes: z.array(
        z.object({
          location: z.object({ id: id('Location'), name: z.string() }),
          movable: z.boolean(),
          unavailableLineItemsCount: z
            .object({ count: z.number().int(), precision: z.string() })
            .nullable(),
        }),
      ),
      pageInfo: z.object({ hasNextPage: z.boolean() }),
    })
    .optional(),
});

const fields = `id updatedAt status requestStatus order { id }
  assignedLocation { name location { id } }
  supportedActions { action }
  fulfillmentHolds { id reason heldByRequestingApp }
  lineItems(first: 250) { nodes { lineItem { id } remainingQuantity totalQuantity } pageInfo { hasNextPage } }`;

export interface RecoveryEvidence {
  id: string;
  kind: 'observation' | 'acceptance';
  observedAt: string;
  document: unknown;
}

/** Reads exact fulfillment orders and dispatches single, non-replayed mutations after a fresh eligibility check. */
export function createFulfillmentProvider(
  options: ShopifyTransportOptions & {
    tenantId: string;
    connectionId: string;
    record(evidence: RecoveryEvidence): Promise<void>;
    now?: () => Date;
  },
) {
  const request = createClient(options);
  const now = options.now ?? (() => new Date());

  async function read(
    orderId: string,
    fulfillmentOrderId: string,
  ): Promise<RecoverySnapshot> {
    id('Order').parse(orderId);
    id('FulfillmentOrder').parse(fulfillmentOrderId);
    const observedAt = now().toISOString();
    const data = await request(
      `query LumaFulfillmentRecovery($id: ID!) { node(id: $id) { ... on FulfillmentOrder { ${fields} } } }`,
      { id: fulfillmentOrderId },
    );
    const value = parse(nodeSchema, data.node);
    if (value.id !== fulfillmentOrderId || value.order.id !== orderId)
      throw new ConnectorError({
        code: 'not_found',
        effect: 'none',
        retry: 'never',
      });
    let locations: z.infer<typeof nodeSchema>['locationsForMove'];
    if (value.supportedActions.some((action) => action.action === 'MOVE')) {
      const result = await request(
        `query LumaFulfillmentLocations($id: ID!) { node(id: $id) { ... on FulfillmentOrder { locationsForMove(first: 250) { nodes { location { id name } movable unavailableLineItemsCount { count precision } } pageInfo { hasNextPage } } } } }`,
        { id: fulfillmentOrderId },
      );
      locations = parse(
        z.object({ locationsForMove: nodeSchema.shape.locationsForMove }),
        result.node,
      ).locationsForMove;
    }
    const snapshot: RecoverySnapshot = {
      id: randomUUID(),
      observedAt,
      revision: createHash('sha256')
        .update(JSON.stringify(value))
        .digest('hex'),
      orderId,
      fulfillmentOrderId,
      status: value.status,
      requestStatus: value.requestStatus,
      locationId: value.assignedLocation.location?.id ?? null,
      locationName: value.assignedLocation.name,
      holds: value.fulfillmentHolds,
      actions: value.supportedActions.map((action) => action.action),
      locations:
        locations?.nodes.map((location) => ({
          id: location.location.id,
          name: location.location.name,
          movable:
            location.movable &&
            location.unavailableLineItemsCount?.count === 0 &&
            location.unavailableLineItemsCount.precision === 'EXACT',
        })) ?? [],
      complete:
        !value.lineItems.pageInfo.hasNextPage &&
        !(locations?.pageInfo.hasNextPage ?? false),
      lines: value.lineItems.nodes.map((line) => ({
        id: line.lineItem.id,
        remaining: line.remainingQuantity,
        total: line.totalQuantity,
      })),
    };
    const provenance: ReadProvenance = {
      adapterVersion: fulfillmentRecoveryAdapterVersion,
      completeness: snapshot.complete ? 'complete' : 'partial',
      sourceRevision: snapshot.revision,
      sourceUpdatedAt: sourceTime(value.updatedAt),
      record: { resource: 'fulfillment_order', externalId: fulfillmentOrderId },
    };
    await options.record({
      id: snapshot.id,
      kind: 'observation',
      observedAt,
      document: { ...snapshot, ...provenance },
    });

    return snapshot;
  }

  function handler<K extends RecoveryCapability>(
    capability: K,
  ): CapabilityHandler<K> {
    return {
      descriptor: {
        version: '0',
        minimumRisk: 'medium',
        permission: 'shopify:fulfillment_recovery.run',
        idempotency: 'none',
        retry: { maxAttempts: 1, initialDelayMs: 0 },
      },
      parseInput(input) {
        const value = z
          .object({
            orderId: id('Order'),
            fulfillmentOrderId: id('FulfillmentOrder'),
            expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
            holdId: id('FulfillmentHold').optional(),
            locationId: id('Location').optional(),
          })
          .strict()
          .parse(input);
        recoveryChoice.parse({
          capability,
          ...(value.holdId ? { holdId: value.holdId } : {}),
          ...(value.locationId ? { locationId: value.locationId } : {}),
        });

        return {
          orderId: value.orderId,
          fulfillmentOrderId: value.fulfillmentOrderId,
          expectedRevision: value.expectedRevision,
          ...(value.holdId ? { holdId: value.holdId } : {}),
          ...(value.locationId ? { locationId: value.locationId } : {}),
        };
      },
      parseOutput: (value) =>
        z
          .object({
            status: z.literal('accepted'),
            evidenceRefs: z.array(z.string().uuid()).min(1),
            providerRequestId: z.string().nullable(),
          })
          .strict()
          .parse(value),
      async run(context, input: CapabilityInput<K>) {
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
        const choice = recoveryChoice.parse({
          capability,
          ...(input.holdId ? { holdId: input.holdId } : {}),
          ...(input.locationId ? { locationId: input.locationId } : {}),
        });
        const current = await read(input.orderId, input.fulfillmentOrderId);
        if (
          current.revision !== input.expectedRevision ||
          recoveryBlocker(current, choice, [capability])
        )
          throw new ConnectorError({
            code: 'conflict',
            effect: 'none',
            retry: 'never',
            dispatch: 'not_dispatched',
          });
        const mutation =
          capability === 'fulfillment.hold.release'
            ? 'fulfillmentOrderReleaseHold'
            : capability === 'fulfillment.open'
              ? 'fulfillmentOrderOpen'
              : 'fulfillmentOrderMove';
        const extra =
          choice.capability === 'fulfillment.hold.release'
            ? ', $holdIds: [ID!]'
            : choice.capability === 'fulfillment.move'
              ? ', $newLocationId: ID!'
              : '';
        const args =
          choice.capability === 'fulfillment.hold.release'
            ? ', holdIds: $holdIds'
            : choice.capability === 'fulfillment.move'
              ? ', newLocationId: $newLocationId'
              : '';
        const resultField =
          capability === 'fulfillment.move'
            ? 'movedFulfillmentOrder'
            : 'fulfillmentOrder';
        let raw: Record<string, unknown>;
        try {
          raw = await request(
            `mutation LumaFulfillmentRecovery($id: ID!${extra}) { result: ${mutation}(id: $id${args}) { resultOrder: ${resultField} { id order { id } } userErrors { field message } } }`,
            {
              id: input.fulfillmentOrderId,
              ...(choice.capability === 'fulfillment.hold.release'
                ? { holdIds: [choice.holdId] }
                : {}),
              ...(choice.capability === 'fulfillment.move'
                ? { newLocationId: choice.locationId }
                : {}),
            },
          );
          const result = parse(
            z.object({
              resultOrder: z
                .object({
                  id: id('FulfillmentOrder'),
                  order: z.object({ id: id('Order') }),
                })
                .nullable(),
              userErrors: z.array(
                z.object({
                  field: z.array(z.string()).nullable(),
                  message: z.string(),
                }),
              ),
            }),
            raw.result,
          );
          if (result.userErrors.length && result.resultOrder)
            throw new Error('Mutation returned an ambiguous receipt');
          if (result.userErrors.length)
            throw new ConnectorError({
              code: 'conflict',
              effect: 'none',
              retry: 'never',
              dispatch: 'not_dispatched',
            });
          if (
            !result.resultOrder ||
            result.resultOrder.order.id !== input.orderId ||
            (capability !== 'fulfillment.move' &&
              result.resultOrder.id !== input.fulfillmentOrderId)
          )
            throw new Error('Invalid mutation receipt');
          const evidenceId = randomUUID();
          const resultOrder = result.resultOrder;
          await storeAcceptance(() =>
            options.record({
              id: evidenceId,
              kind: 'acceptance',
              observedAt: now().toISOString(),
              document: {
                capability,
                fulfillmentOrderId: input.fulfillmentOrderId,
                resultFulfillmentOrderId: resultOrder.id,
                orderId: input.orderId,
                ...acceptanceProvenance(context, [
                  { resource: 'fulfillment_order', externalId: resultOrder.id },
                  { resource: 'order', externalId: resultOrder.order.id },
                ]),
              },
            }),
          );

          return {
            status: 'accepted',
            evidenceRefs: [evidenceId],
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
  }

  return {
    read,
    capabilities: {
      'fulfillment.hold.release': handler('fulfillment.hold.release'),
      'fulfillment.open': handler('fulfillment.open'),
      'fulfillment.move': handler('fulfillment.move'),
    },
  };
}
