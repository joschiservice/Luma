import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { TenantContext } from '@luma/identity';
import { buildSchema, parse as parseGraphql, validate } from 'graphql';
import { describe, expect, it, vi } from 'vitest';

import type { PublishingRun } from '../application/shipment-publishing.js';
import type { DispatchEvidence } from '../domain/shipment-publishing.js';
import { createPublishingProvider } from './shipment-publishing-provider.js';

const schema = buildSchema(
  readFileSync(
    new URL('./fixtures/admin-2026-07.graphql', import.meta.url),
    'utf8',
  ),
);
const gid = (kind: string, id = 1) => `gid://shopify/${kind}/${id}`;

async function fixture() {
  const tenantId = randomUUID(),
    connectionId = randomUUID(),
    operationId = randomUUID();
  const dispatch: DispatchEvidence = {
    id: randomUUID(),
    observationId: randomUUID(),
    observedAt: new Date().toISOString(),
    revision: 'dispatch1',
    complete: true,
    connectionId: randomUUID(),
    shipmentId: 'parcel1',
    stage: 'carrier',
    locationId: null,
    lines: [],
    tracking: [
      {
        company: 'Synthetic Carrier',
        number: 'parcel1',
        url: 'https://tracking.example.test/parcel1',
      },
    ],
  };
  const node = {
    id: gid('Order'),
    updatedAt: '2026-10-13T00:00:00Z',
    cancelledAt: null as string | null,
    fulfillmentOrders: {
      nodes: [
        {
          id: gid('FulfillmentOrder'),
          status: 'OPEN',
          requestStatus: 'UNSUBMITTED',
          supportedActions: [{ action: 'CREATE_FULFILLMENT' }],
          assignedLocation: { location: { id: gid('Location') } },
          lineItems: {
            nodes: [
              {
                id: gid('FulfillmentOrderLineItem'),
                lineItem: { id: gid('LineItem') },
                remainingQuantity: 3,
                totalQuantity: 3,
              },
            ],
            pageInfo: { hasNextPage: false },
          },
        },
      ],
      pageInfo: { hasNextPage: false },
    },
    fulfillments: [],
  };
  const mutations: { query: string; variables: Record<string, unknown> }[] = [];
  let lost = false,
    gate: 'started' | 'sent' | 'closed' = 'started',
    enabled = true,
    granted = ['fulfillment.shipment.create', 'fulfillment.tracking.update'];
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    expect(validate(schema, parseGraphql(body.query))).toEqual([]);
    if (body.query.startsWith('mutation')) {
      mutations.push(body);
      if (lost) throw new Error('Response lost');

      return Response.json({
        data: {
          result: { fulfillment: { id: gid('Fulfillment') }, userErrors: [] },
        },
      });
    }

    return Response.json({ data: { node } });
  });
  const provider = createPublishingProvider({
    tenantId,
    connectionId,
    shop: 'publishing.myshopify.com',
    accessToken: async () => 'synthetic',
    fetch,
    record: async () => {},
    load: async () => run,
    dispatch: async () => dispatch,
    sent: async () => {
      const current = gate;
      if (gate === 'started') gate = 'sent';

      return current;
    },
    enabled: async () => enabled,
    granted: async () => granted,
  });
  const before = await provider.read(gid('Order'), dispatch);
  const run: PublishingRun = {
    id: operationId,
    tenantId,
    target: { connectionId, orderId: gid('Order') },
    before,
    choice: {
      capability: 'fulfillment.shipment.create',
      source: {
        downstreamConnectionId: dispatch.connectionId,
        shipmentId: dispatch.shipmentId,
      },
      allocations: [
        {
          fulfillmentOrderId: gid('FulfillmentOrder'),
          fulfillmentOrderLineId: gid('FulfillmentOrderLineItem'),
          orderLineId: gid('LineItem'),
          locationId: gid('Location'),
          quantity: 1,
        },
      ],
      allocationSource: 'operator',
      notifyCustomer: false,
    },
    decisionId: null,
    action: {
      schemaVersion: 1,
      id: operationId,
      tenantId,
      capability: 'fulfillment.shipment.create',
      capabilityVersion: '0',
      connectionId,
      target: { kind: 'shopify_shipment_publication', id: operationId },
      parameters: {},
      preconditions: {
        evidenceRefs: [before.id],
        validUntil: new Date(Date.now() + 300_000).toISOString(),
      },
      expectedPostcondition: { shipmentPublished: true },
      risk: 'high',
      proposedBy: { kind: 'user', id: 'requester' },
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    },
  };
  const context = {
    tenant: { tenantId } as TenantContext,
    connectionId,
    provider: 'shopify',
    idempotencyKey: operationId,
  };
  const input = {
    operationId,
    orderId: gid('Order'),
    expectedRevision: before.revision,
  };

  return {
    provider,
    run,
    node,
    mutations,
    context,
    input,
    lose: () => {
      lost = true;
    },
    close: () => {
      gate = 'closed';
    },
    disable: () => {
      enabled = false;
    },
    revoke: () => {
      granted = [];
    },
  };
}

describe('persisted Shopify shipment provider', () => {
  it('sends only saved exact quantities and the explicit notification choice', async () => {
    const f = await fixture();
    await f.provider.capabilities['fulfillment.shipment.create'].run(
      f.context,
      f.input,
    );
    expect(f.mutations).toHaveLength(1);
    expect(f.mutations[0]?.variables).toMatchObject({
      fulfillment: {
        notifyCustomer: false,
        lineItemsByFulfillmentOrder: [
          {
            fulfillmentOrderId: gid('FulfillmentOrder'),
            fulfillmentOrderLineItems: [
              { id: gid('FulfillmentOrderLineItem'), quantity: 1 },
            ],
          },
        ],
        trackingInfo: {
          company: 'Synthetic Carrier',
          numbers: ['parcel1'],
          urls: ['https://tracking.example.test/parcel1'],
        },
      },
    });
    expect(() =>
      f.provider.capabilities['fulfillment.shipment.create'].parseInput({
        ...f.input,
        quantity: 3,
      }),
    ).toThrow();
  });
  it('never replays a reserved send after a lost response', async () => {
    const f = await fixture();
    f.lose();
    await expect(
      f.provider.capabilities['fulfillment.shipment.create'].run(
        f.context,
        f.input,
      ),
    ).rejects.toMatchObject({
      failure: { effect: 'unknown', dispatch: 'uncertain' },
    });
    await expect(
      f.provider.capabilities['fulfillment.shipment.create'].run(
        f.context,
        f.input,
      ),
    ).rejects.toMatchObject({
      failure: { effect: 'unknown', dispatch: 'uncertain' },
    });
    expect(f.mutations).toHaveLength(1);
  });
  it('fencing unsent reconciliation prevents a delayed continuation from sending', async () => {
    const f = await fixture();
    f.close();
    await expect(
      f.provider.capabilities['fulfillment.shipment.create'].run(
        f.context,
        f.input,
      ),
    ).rejects.toMatchObject({
      failure: { effect: 'none', dispatch: 'not_dispatched' },
    });
    expect(f.mutations).toHaveLength(0);
  });
  it('rechecks release and current provider write grants immediately before sending', async () => {
    for (const change of ['disable', 'revoke'] as const) {
      const f = await fixture();
      f[change]();
      await expect(
        f.provider.capabilities['fulfillment.shipment.create'].run(
          f.context,
          f.input,
        ),
      ).rejects.toMatchObject({ failure: { dispatch: 'not_dispatched' } });
      expect(f.mutations).toHaveLength(0);
    }
  });
});
