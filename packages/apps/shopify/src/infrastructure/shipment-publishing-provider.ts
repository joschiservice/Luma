import { createHash, randomUUID } from 'node:crypto';

import { type CapabilityHandler, ConnectorError } from '@luma/connections';
import {
  createClient,
  parse,
  type ShopifyTransportOptions,
} from '@luma/connector-shopify';
import { canonicalJson } from '@luma/platform';
import { z } from 'zod';

import type { PublishingRun } from '../application/shipment-publishing.js';
import {
  type DispatchEvidence,
  publishingBlocker,
  type PublishingCapability,
  type PublishingSnapshot,
  publishingSnapshot,
} from '../domain/shipment-publishing.js';
import {
  acceptanceProvenance,
  type ReadProvenance,
  settledDispatch,
  sourceTime,
  storeAcceptance,
} from './evidence-provenance.js';

const fields = `id updatedAt cancelledAt
 fulfillmentOrders(first: 5) { nodes { id status requestStatus supportedActions { action } assignedLocation { name location { id } } lineItems(first: 20) { nodes { id lineItem { id name } remainingQuantity totalQuantity } pageInfo { hasNextPage } } } pageInfo { hasNextPage } }
 fulfillments(first: 5) { id status location { id } fulfillmentOrders(first: 5) { nodes { id } pageInfo { hasNextPage } } trackingInfo(first: 21) { company number url } fulfillmentLineItems(first: 20) { nodes { quantity lineItem { id } } pageInfo { hasNextPage } } }`;
const rawSchema = z.object({
  id: z.string(),
  updatedAt: z.string(),
  cancelledAt: z.string().nullable(),
  fulfillmentOrders: z.object({
    nodes: z.array(
      z.object({
        id: z.string(),
        status: z.string(),
        requestStatus: z.string(),
        supportedActions: z.array(z.object({ action: z.string() })),
        assignedLocation: z.object({
          name: z.string().default(''),
          location: z.object({ id: z.string() }).nullable(),
        }),
        lineItems: z.object({
          nodes: z.array(
            z.object({
              id: z.string(),
              lineItem: z.object({
                id: z.string(),
                name: z.string().default(''),
              }),
              remainingQuantity: z.number().int(),
              totalQuantity: z.number().int(),
            }),
          ),
          pageInfo: z.object({ hasNextPage: z.boolean() }),
        }),
      }),
    ),
    pageInfo: z.object({ hasNextPage: z.boolean() }),
  }),
  fulfillments: z.array(
    z.object({
      id: z.string(),
      status: z.string(),
      location: z.object({ id: z.string() }).nullable(),
      fulfillmentOrders: z.object({
        nodes: z.array(z.object({ id: z.string() })),
        pageInfo: z.object({ hasNextPage: z.boolean() }),
      }),
      trackingInfo: z.array(
        z.object({
          company: z.string().nullable(),
          number: z.string().nullable(),
          url: z.string().nullable(),
        }),
      ),
      fulfillmentLineItems: z.object({
        nodes: z.array(
          z.object({
            quantity: z.number().int().positive(),
            lineItem: z.object({ id: z.string() }),
          }),
        ),
        pageInfo: z.object({ hasNextPage: z.boolean() }),
      }),
    }),
  ),
});

/** Identifies the normalization of publishing reads; publications dispatch under it too. */
export const shipmentPublishingAdapterVersion = 'shopify-fulfillment/1';

export interface PublishingEvidence {
  id: string;
  kind: 'observation' | 'acceptance';
  observedAt: string;
  document: unknown;
}

/** Reads bounded complete Shopify allocations and sends the exact persisted intent once, with a durable send fence. */
export function createPublishingProvider(
  options: ShopifyTransportOptions & {
    tenantId: string;
    connectionId: string;
    record(evidence: PublishingEvidence): Promise<void>;
    load(operationId: string): Promise<PublishingRun | null>;
    dispatch(run: PublishingRun): Promise<DispatchEvidence | null>;
    sent(operationId: string): Promise<'started' | 'sent' | 'closed'>;
    enabled(): Promise<boolean>;
    granted(): Promise<readonly string[]>;
    now?: () => Date;
  },
) {
  const request = createClient(options),
    now = options.now ?? (() => new Date());

  async function read(
    orderId: string,
    dispatch: DispatchEvidence | null,
  ): Promise<PublishingSnapshot> {
    const observedAt = now().toISOString();
    const result = await request(
      `query LumaShipmentPublishingRead($id: ID!) { node(id:$id) { ... on Order { ${fields} } } }`,
      { id: orderId },
    );
    if (!result.node)
      throw new ConnectorError({
        code: 'not_found',
        effect: 'none',
        retry: 'never',
      });
    const raw = parse(rawSchema, result.node);
    if (raw.id !== orderId)
      throw new ConnectorError({
        code: 'invalid_response',
        effect: 'none',
        retry: 'never',
      });
    const current = publishingSnapshot.parse({
      id: randomUUID(),
      observedAt,
      orderId,
      cancelled: raw.cancelledAt !== null,
      revision: createHash('sha256')
        .update(canonicalJson({ raw, dispatch: dispatch?.revision ?? null }))
        .digest('hex'),
      complete:
        !raw.fulfillmentOrders.pageInfo.hasNextPage &&
        raw.fulfillmentOrders.nodes.every(
          (w) =>
            !w.lineItems.pageInfo.hasNextPage && w.lineItems.nodes.length <= 20,
        ) &&
        raw.fulfillments.length < 5 &&
        raw.fulfillments.every(
          (s) =>
            !s.fulfillmentOrders.pageInfo.hasNextPage &&
            !s.fulfillmentLineItems.pageInfo.hasNextPage &&
            s.fulfillmentLineItems.nodes.length <= 20 &&
            s.trackingInfo.length <= 20 &&
            s.trackingInfo.every((t) => t.number !== null),
        ),
      work: raw.fulfillmentOrders.nodes.map((w) => ({
        id: w.id,
        status: w.status,
        requestStatus: w.requestStatus,
        locationId: w.assignedLocation.location?.id ?? null,
        locationName: w.assignedLocation.name,
        actions: w.supportedActions.map((a) => a.action),
        lines: w.lineItems.nodes.map((l) => ({
          id: l.id,
          orderLineId: l.lineItem.id,
          name: l.lineItem.name,
          remaining: l.remainingQuantity,
          total: l.totalQuantity,
        })),
      })),
      shipments: raw.fulfillments.map((s) => ({
        id: s.id,
        fulfillmentOrderIds: s.fulfillmentOrders.nodes.map((w) => w.id),
        status: s.status,
        locationId: s.location?.id ?? null,
        tracking: s.trackingInfo.filter(
          (
            t,
          ): t is {
            company: string | null;
            number: string;
            url: string | null;
          } => t.number !== null,
        ),
        lines: s.fulfillmentLineItems.nodes.map((l) => ({
          orderLineId: l.lineItem.id,
          quantity: l.quantity,
        })),
      })),
      dispatch,
    });
    // Pages and bounds Luma did not read leave the allocation read partial.
    const provenance: ReadProvenance = {
      adapterVersion: shipmentPublishingAdapterVersion,
      completeness: current.complete ? 'complete' : 'partial',
      sourceRevision: current.revision,
      sourceUpdatedAt: sourceTime(raw.updatedAt),
      record: { resource: 'order', externalId: orderId },
    };
    await options.record({
      id: current.id,
      kind: 'observation',
      observedAt,
      document: { ...current, ...provenance },
    });

    return current;
  }

  function handler(
    capability: PublishingCapability,
  ): CapabilityHandler<typeof capability> {
    return {
      descriptor: {
        version: '0',
        minimumRisk: 'high',
        permission: 'shopify:shipment_publishing.run',
        idempotency: 'none',
        retry: { maxAttempts: 1, initialDelayMs: 0 },
      },
      parseInput: (input) =>
        z
          .object({
            operationId: z.string().uuid(),
            orderId: z.string().regex(/^gid:\/\/shopify\/Order\/[0-9]+$/),
            expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
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
      async run(context, input) {
        const run = await options.load(input.operationId);
        if (
          context.tenant.tenantId !== options.tenantId ||
          context.connectionId !== options.connectionId ||
          context.provider !== 'shopify' ||
          !context.idempotencyKey ||
          !run ||
          run.choice.capability !== capability ||
          run.target.connectionId !== options.connectionId ||
          run.target.orderId !== input.orderId ||
          run.before.revision !== input.expectedRevision
        )
          throw new ConnectorError({
            code: 'permission_denied',
            effect: 'none',
            retry: 'never',
          });
        const current = await read(input.orderId, await options.dispatch(run));
        if (
          !(await options.enabled()) ||
          current.revision !== input.expectedRevision ||
          publishingBlocker(
            current,
            run.choice,
            await options.granted(),
            now().getTime(),
          )
        )
          throw new ConnectorError({
            code: 'conflict',
            effect: 'none',
            retry: 'never',
            dispatch: 'not_dispatched',
          });
        const sendState = await options.sent(run.id);
        if (sendState === 'closed')
          throw new ConnectorError({
            code: 'conflict',
            effect: 'none',
            retry: 'never',
            dispatch: 'not_dispatched',
          });
        if (sendState !== 'started')
          throw new ConnectorError({
            code: 'conflict',
            effect: 'unknown',
            retry: 'reconcile',
            dispatch: 'uncertain',
          });
        const source = run.before.dispatch!;
        const trackingInfo = {
          ...(source.tracking[0]?.company
            ? { company: source.tracking[0].company }
            : {}),
          numbers: source.tracking.map((t) => t.number),
          ...(source.tracking.every((t) => t.url !== null)
            ? { urls: source.tracking.map((t) => t.url) }
            : {}),
        };
        const choice = run.choice;
        const groups =
          choice.capability === 'fulfillment.shipment.create'
            ? [
                ...new Set(choice.allocations.map((a) => a.fulfillmentOrderId)),
              ].map((id) => ({
                fulfillmentOrderId: id,
                fulfillmentOrderLineItems: choice.allocations
                  .filter((a) => a.fulfillmentOrderId === id)
                  .map((a) => ({
                    id: a.fulfillmentOrderLineId,
                    quantity: a.quantity,
                  })),
              }))
            : [];
        try {
          const mutation =
            choice.capability === 'fulfillment.shipment.create'
              ? 'fulfillmentCreate'
              : 'fulfillmentTrackingInfoUpdate';
          const result = await request(
            choice.capability === 'fulfillment.shipment.create'
              ? `mutation LumaShipmentPublishingCreate($fulfillment: FulfillmentInput!, $message:String) { result:fulfillmentCreate(fulfillment:$fulfillment,message:$message) { fulfillment { id } userErrors { field message } } }`
              : `mutation LumaShipmentPublishingTracking($fulfillmentId:ID!,$trackingInfoInput:FulfillmentTrackingInput!,$notifyCustomer:Boolean) { result:fulfillmentTrackingInfoUpdate(fulfillmentId:$fulfillmentId,trackingInfoInput:$trackingInfoInput,notifyCustomer:$notifyCustomer) { fulfillment { id } userErrors { field message } } }`,
            choice.capability === 'fulfillment.shipment.create'
              ? {
                  fulfillment: {
                    notifyCustomer: choice.notifyCustomer,
                    trackingInfo,
                    lineItemsByFulfillmentOrder: groups,
                  },
                  message: `luma-sp:${run.id}`,
                }
              : {
                  fulfillmentId: choice.fulfillmentId,
                  trackingInfoInput: trackingInfo,
                  notifyCustomer: choice.notifyCustomer,
                },
          );
          const receipt = parse(
            z.object({
              fulfillment: z
                .object({
                  id: z
                    .string()
                    .regex(/^gid:\/\/shopify\/Fulfillment\/[0-9]+$/),
                })
                .nullable(),
              userErrors: z.array(
                z.object({
                  field: z.array(z.string()).nullable(),
                  message: z.string(),
                }),
              ),
            }),
            result.result,
          );
          if (receipt.userErrors.length && !receipt.fulfillment)
            throw new ConnectorError({
              code: 'conflict',
              effect: 'none',
              retry: 'never',
              dispatch: 'not_dispatched',
            });
          if (
            receipt.userErrors.length ||
            !receipt.fulfillment ||
            (choice.capability === 'fulfillment.tracking.update' &&
              receipt.fulfillment.id !== choice.fulfillmentId)
          )
            throw new Error('Ambiguous shipment receipt');
          const id = randomUUID();
          const fulfillmentId = receipt.fulfillment.id;
          await storeAcceptance(() =>
            options.record({
              id,
              kind: 'acceptance',
              observedAt: now().toISOString(),
              document: {
                capability,
                operationId: run.id,
                mutation,
                fulfillmentId,
                orderId: run.target.orderId,
                ...acceptanceProvenance(context, [
                  { resource: 'fulfillment', externalId: fulfillmentId },
                  { resource: 'order', externalId: run.target.orderId },
                ]),
              },
            }),
          );

          return {
            status: 'accepted',
            evidenceRefs: [id],
            providerRequestId: receipt.fulfillment.id,
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
      'fulfillment.shipment.create': handler('fulfillment.shipment.create'),
      'fulfillment.tracking.update': handler('fulfillment.tracking.update'),
    },
  };
}
