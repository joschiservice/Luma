import { createHash, randomUUID } from 'node:crypto';

import {
  type CapabilityHandler,
  type CapabilityOutput,
  type ConnectorConnection,
  ConnectorError,
  type InvocationContext,
} from '@luma/connections';
import { API_VERSION, createClient, fail, parse } from '@luma/connector-jtl';
import {
  shippingMethodResponse,
  shippingMethodState,
} from '@luma/connector-jtl/schemas';
import { z } from 'zod';

import type { JtlConnectorOptions } from './adapter.js';
import { adapterVersion } from './outputs.js';
import { externalId } from './schemas.js';

const ref = z.object({ externalId, scopeKey: z.literal('') }).strict();

export {
  shippingMethodState,
  shippingMethodResponse,
} from '@luma/connector-jtl/schemas';

const writeInput = z
  .object({ order: ref, expectedShippingMethod: ref, shippingMethod: ref })
  .strict()
  .refine(
    (value) =>
      value.expectedShippingMethod.externalId !==
      value.shippingMethod.externalId,
  );

const receipt = z
  .object({
    status: z.literal('accepted'),
    evidenceRefs: z.array(z.string().min(1)).min(1),
    providerRequestId: z.string().nullable(),
  })
  .strict();

const readOutput = z
  .object({
    items: z
      .array(
        z
          .object({
            id: z.string().min(1),
            source: z
              .object({
                tenantId: z.string(),
                connectionId: z.string(),
                provider: z.literal('jtl'),
                resource: z.literal('order'),
                externalId,
                scopeKey: z.literal(''),
              })
              .strict(),
            kind: z.literal('snapshot'),
            observedAt: z.string().datetime(),
            sourceUpdatedAt: z.null(),
            sourceRevision: z.null(),
            adapterVersion: z.literal(adapterVersion),
            schemaVersion: z.literal(1),
            data: z
              .object({
                shippingMethod: ref,
                isCancelled: z.boolean(),
                orderStatus: z.enum([
                  'open',
                  'shipped',
                  'cancelled',
                  'unknown',
                ]),
              })
              .strict(),
          })
          .strict(),
      )
      .length(1),
    nextCursor: z.null(),
    completeness: z.literal('complete'),
  })
  .strict();

/** Shipping-method correction and its inverse use separate approved execution intents. */
export function createJtlShippingMethodCapabilities(
  options: JtlConnectorOptions,
): ConnectorConnection['capabilities'] {
  const client = createClient(options);
  const now = options.now ?? (() => new Date());

  function check(context: InvocationContext) {
    if (
      context.tenant.tenantId !== options.tenantId ||
      context.connectionId !== options.connectionId ||
      context.provider !== 'jtl'
    )
      fail('unavailable');
  }

  async function observe(
    order: z.infer<typeof ref>,
  ): Promise<CapabilityOutput<'orders.shipping-method.read'>> {
    const state = parse(
      shippingMethodState,
      await client.request(`sales-orders/${order.externalId}`),
    );
    if (state.id !== order.externalId) fail('invalid_response');
    const result = readOutput.parse({
      items: [
        {
          id: (options.id ?? randomUUID)(),
          source: {
            ...order,
            tenantId: options.tenantId,
            connectionId: options.connectionId,
            provider: 'jtl',
            resource: 'order',
          },
          kind: 'snapshot',
          observedAt: now().toISOString(),
          sourceUpdatedAt: null,
          sourceRevision: null,
          adapterVersion,
          schemaVersion: 1,
          data: {
            shippingMethod: {
              externalId: state.shippingMethodId,
              scopeKey: '',
            },
            isCancelled: state.isCancelled,
            orderStatus: state.isCancelled
              ? 'cancelled'
              : !state.shippingDetails
                ? 'unknown'
                : state.shippingDetails.shippingDate
                  ? 'shipped'
                  : 'open',
          },
        },
      ],
      nextCursor: null,
      completeness: 'complete',
    });
    await options.recordObservations({
      tenantId: options.tenantId,
      connectionId: options.connectionId,
      apiVersion: API_VERSION,
      capability: 'orders.shipping-method.read',
      observations: result.items,
    });

    return result;
  }

  const read: CapabilityHandler<'orders.shipping-method.read'> = {
    descriptor: {
      version: '0',
      minimumRisk: 'low',
      idempotency: 'none',
      retry: { maxAttempts: 3, initialDelayMs: 1000 },
    },
    parseInput: (value) =>
      z
        .object({ order: ref, limit: z.literal(1) })
        .strict()
        .parse(value),
    parseOutput: (value) => readOutput.parse(value),
    async run(context, input) {
      check(context);

      return observe(ref.parse(input.order));
    },
  };
  const write: CapabilityHandler<'orders.shipping-method.write'> = {
    descriptor: {
      version: '0',
      minimumRisk: 'high',
      idempotency: 'provider_key',
      retry: { maxAttempts: 1, initialDelayMs: 0 },
    },
    parseInput: (value) => writeInput.parse(value),
    parseOutput: (value) => receipt.parse(value),
    async run(context, input) {
      check(context);
      input = writeInput.parse(input);
      if (!context.idempotencyKey?.trim()) fail('invalid_input');
      let before: CapabilityOutput<'orders.shipping-method.read'>['items'][number];
      try {
        before = (await observe(ref.parse(input.order))).items[0]!;
      } catch (error) {
        if (error instanceof ConnectorError) throw error;
        fail('internal');
      }
      if (
        before.data.orderStatus !== 'open' ||
        before.data.isCancelled ||
        before.data.shippingMethod.externalId !==
          input.expectedShippingMethod.externalId
      )
        fail('conflict');
      // Execution binds this logical key to immutable intent. Do not derive a new key from changed parameters.
      const key = createHash('sha256')
        .update(
          JSON.stringify([
            options.tenantId,
            options.connectionId,
            client.binding,
            'orders.shipping-method.write',
            context.idempotencyKey,
          ]),
        )
        .digest('hex');
      let providerRequestId: string | null = null;
      const response = await client.request(
        `sales-orders/${input.order.externalId}`,
        {},
        {
          body: {
            shippingMethodId: input.shippingMethod.externalId,
            disableAutomaticWorkflows: true,
          },
          idempotencyKey: key,
          receipt: (id) => {
            providerRequestId = id;
          },
        },
      );
      const parsed = shippingMethodResponse.safeParse(response);
      if (
        !parsed.success ||
        parsed.data.salesOrderId !== input.order.externalId
      )
        throw new ConnectorError({
          code: 'invalid_response',
          ...(providerRequestId ? { providerRequestId } : {}),
          effect: 'unknown',
          retry: 'reconcile',
        });

      return {
        status: 'accepted',
        evidenceRefs: [before.id],
        providerRequestId,
      };
    },
  };

  return {
    'orders.shipping-method.read': read,
    'orders.shipping-method.write': write,
  };
}
