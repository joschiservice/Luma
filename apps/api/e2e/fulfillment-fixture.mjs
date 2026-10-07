import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import {
  createCommerceServices,
  createDetectionServices,
} from '@luma/application-runtime';
import { defaultConfiguration } from '@luma/exceptions';
import { builtInMembership, makeTenantContext } from '@luma/identity';

import { ordersFixture } from './orders-fixture.mjs';

const hour = 3_600_000;

/**
 * Seeds fulfillment work through commerce ingestion on top of the orders fixture:
 * - #200: a Shopify fulfillment order put on hold (incorrect address) past its fulfill-by date;
 * - #201: an open Shopify fulfillment order without progress for three days;
 * - #202: a closed Shopify fulfillment order and its shipment with a failed delivery attempt;
 * - #203: a delivered Shopify shipment;
 * - #300: a JTL shipment still being packed, updated an hour ago.
 */
export async function fulfillmentFixture(t, f) {
  const orders = await ordersFixture(t, f);
  const commerce = createCommerceServices(f.db.ownerUrl);
  t.onTestFinished(() => commerce.close());
  const context = makeTenantContext(
    { userId: f.owner.id, sessionId: 'fixture' },
    { ...f.org, status: 'active', dataRegion: 'EU' },
    builtInMembership(
      { id: randomUUID(), organizationId: f.org.id, userId: f.owner.id },
      'owner',
    ),
    randomUUID(),
  );
  const ago = (hours) => new Date(Date.now() - hours * hour).toISOString();

  /** Ingests one fulfillment observation and binds it and any location by explicit keys. */
  async function fulfillment({
    connectionId = orders.store,
    external,
    order,
    lines,
    status,
    time = ago(1),
    progressAt = time,
    deleted = false,
    facts = {},
  }) {
    const source = {
      tenantId: f.org.id,
      connectionId,
      provider: connectionId === orders.erp ? 'jtl' : 'shopify',
      resource: 'fulfillment',
      externalId: external,
      scopeKey: '',
    };
    const id = randomUUID();
    await commerce.ingestion.ingest(context, id, {
      capability: 'fulfillment.read',
      observation: {
        id,
        source,
        kind: deleted ? 'tombstone' : 'snapshot',
        observedAt: time,
        sourceUpdatedAt: connectionId === orders.erp ? null : time,
        sourceRevision: null,
        adapterVersion: 'fixture/1',
        schemaVersion: 1,
        data: {
          order: { externalId: order, scopeKey: '' },
          status,
          lines: lines.map((line) => ({
            orderLine: { externalId: line.external, scopeKey: order },
            quantity: { amount: line.quantity, unit: 'each' },
          })),
          lastProgressAt: progressAt,
          failureCode: status === 'failed' ? 'fulfillment_failed' : null,
          ...facts,
        },
      },
    });
    const fulfillmentId = await commerce.ingestion.bind(
      context,
      source,
      `fulfillment:${connectionId}:${external}`,
      id,
      'operator-confirmed',
    );
    if (facts.location)
      await commerce.ingestion.bind(
        context,
        { ...source, resource: 'location', ...facts.location.id },
        `location:${facts.location.id.externalId}`,
        id,
        'operator-confirmed',
      );
    await commerce.ingestion.replay(context, connectionId, id);

    return fulfillmentId;
  }

  const line = (external) => [
    { external, sku: 'SKU-100', skuKey: 'SKU-100', quantity: '2' },
  ];
  const tokyo = {
    id: { externalId: 'gid://shopify/Location/41', scopeKey: '' },
    name: 'Tokyo warehouse',
  };
  for (const [number, placed] of [
    ['200', 80],
    ['201', 90],
    ['202', 50],
    ['203', 120],
  ])
    await orders.order({
      external: `order-${number}`,
      key: `order-${number}`,
      updatedAt: ago(placed),
      data: { displayNumber: `#${number}`, placedAt: ago(placed) },
      lines: line(`line-${number}`),
    });
  await orders.order({
    connectionId: orders.erp,
    external: '300',
    key: 'order-300',
    updatedAt: ago(10),
    data: { displayNumber: '#300', placedAt: ago(10) },
    lines: [{ external: 'line-300', quantity: '2' }],
  });

  const due = ago(6);
  const work = {
    kind: 'fulfillment_order',
    location: tokyo,
    method: { type: 'shipping', name: 'Express' },
    fulfillAt: null,
  };
  // The hold arrives in a second read, so the timeline shows the change.
  await fulfillment({
    external: 'gid://shopify/FulfillmentOrder/200',
    order: 'order-200',
    lines: [{ external: 'line-200', quantity: '2' }],
    status: 'pending',
    time: ago(30),
    facts: { ...work, holds: [], fulfillBy: due },
  });
  const held = await fulfillment({
    external: 'gid://shopify/FulfillmentOrder/200',
    order: 'order-200',
    lines: [{ external: 'line-200', quantity: '2' }],
    status: 'pending',
    time: ago(20),
    facts: {
      ...work,
      holds: [{ reason: 'incorrect_address' }],
      fulfillBy: due,
    },
  });
  const stalled = await fulfillment({
    external: 'gid://shopify/FulfillmentOrder/201',
    order: 'order-201',
    lines: [{ external: 'line-201', quantity: '2' }],
    status: 'processing',
    time: ago(72),
    facts: { ...work, holds: [], fulfillBy: null },
  });
  const closed = await fulfillment({
    external: 'gid://shopify/FulfillmentOrder/202',
    order: 'order-202',
    lines: [{ external: 'line-202', quantity: '2' }],
    status: 'completed',
    time: ago(40),
    facts: { ...work, holds: [], fulfillBy: ago(30) },
  });
  const attempted = await fulfillment({
    external: 'gid://shopify/Fulfillment/202',
    order: 'order-202',
    lines: [{ external: 'line-202', quantity: '2' }],
    status: 'shipped',
    time: ago(2),
    facts: {
      kind: 'shipment',
      location: tokyo,
      estimatedDeliveryAt: ago(-24),
      tracking: [
        {
          carrier: 'Yamato',
          number: '4521-8876-0012',
          url: 'https://tracking.example.test/4521-8876-0012',
        },
      ],
      delivery: 'attempted_delivery',
    },
  });
  const delivered = await fulfillment({
    external: 'gid://shopify/Fulfillment/203',
    order: 'order-203',
    lines: [{ external: 'line-203', quantity: '2' }],
    status: 'delivered',
    time: ago(24),
    facts: { kind: 'shipment', tracking: [], delivery: 'delivered' },
  });
  const packing = await fulfillment({
    connectionId: orders.erp,
    external: '31',
    order: '300',
    lines: [{ external: 'line-300', quantity: '2' }],
    status: 'processing',
    time: ago(1),
    facts: { kind: 'shipment', tracking: [] },
  });

  /** Opens a stuck-fulfillment issue on the held fulfillment order. */
  async function issue() {
    const services = createDetectionServices(f.db.ownerUrl);
    t.onTestFinished(() => services.close());
    const corpus = JSON.parse(
      await readFile(
        new URL('../../../docs/fixtures/exceptions-v0.json', import.meta.url),
        'utf8',
      ),
    );
    const key = randomUUID();
    const time = new Date().toISOString();
    const result = await services.exceptions.ingest(context, {
      key: randomUUID(),
      configuration: defaultConfiguration,
      input: {
        exceptionClass: 'stuck_fulfillment',
        facts: {
          ...corpus.bases.stuck_fulfillment,
          tenantId: f.org.id,
          evidenceTenantId: f.org.id,
          subjectId: held,
          connectionId: orders.store,
          evidenceRefs: [key],
          observedAt: time,
          lastProgressAt: ago(20),
          otherOperationShippedQuantity: '0',
        },
      },
      evidence: [
        {
          key,
          tenantId: f.org.id,
          connectionId: orders.store,
          observedAt: time,
          sourceUpdatedAt: null,
          adapterVersion: 'fixture/1',
          schemaVersion: 1,
          source: {
            provider: 'shopify',
            resource: 'fulfillment',
            externalId: 'gid://shopify/FulfillmentOrder/200',
            scopeKey: '',
          },
          facts: { status: 'processing' },
        },
      ],
    });

    return result.incident.id;
  }

  return {
    ...orders,
    fulfillment,
    issue,
    ids: { held, stalled, closed, attempted, delivered, packing },
  };
}
