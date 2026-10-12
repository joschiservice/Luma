import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import {
  createCommerceServices,
  createDetectionServices,
} from '@luma/application-runtime';
import { defaultConfiguration } from '@luma/exceptions';
import { builtInMembership, makeTenantContext } from '@luma/identity';

import { ordersFixture } from './orders-fixture.mjs';

/** Seeds mapped stock from both sources and a related order through commerce ingestion. */
export async function inventoryFixture(t, f) {
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

  async function stock({
    connectionId = orders.store,
    external = 'SKU-100',
    sku = 'SKU-100',
    location = 'Tokyo',
    amount = '12',
    onHand = null,
    reserved = null,
    unit = 'each',
    deleted = false,
    states = {},
    time = new Date().toISOString(),
  } = {}) {
    const source = {
      tenantId: f.org.id,
      connectionId,
      provider: connectionId === orders.erp ? 'jtl' : 'shopify',
      resource: 'sku',
      externalId: external,
      scopeKey: '',
    };
    const observation = {
      capability: 'inventory.read',
      observation: {
        id: randomUUID(),
        source,
        kind: deleted ? 'tombstone' : 'snapshot',
        observedAt: time,
        sourceUpdatedAt: time,
        sourceRevision: null,
        adapterVersion: 'fixture/1',
        schemaVersion: 1,
        data: {
          sku: { externalId: external, scopeKey: '' },
          location: { externalId: location, scopeKey: '' },
          unit,
          onHand,
          reserved,
          available: amount,
          availabilityBasis: 'provider_reported',
          ...states,
        },
      },
    };
    const key = observation.observation.id;
    await commerce.ingestion.ingest(context, key, observation);
    const skuId = await commerce.ingestion.bind(
      context,
      source,
      sku,
      key,
      'operator-confirmed',
    );
    await commerce.ingestion.bind(
      context,
      { ...source, resource: 'location', externalId: location },
      location,
      key,
      'operator-confirmed',
    );
    await commerce.ingestion.replay(context, connectionId, key);

    return skuId;
  }

  const old = new Date(Date.now() - 7_200_000).toISOString();
  await stock({
    connectionId: orders.erp,
    external: '77',
    amount: '8',
    onHand: '10',
    reserved: '2',
    time: old,
  });
  const skuId = await stock({
    connectionId: orders.erp,
    external: '77',
    amount: '9',
    onHand: '11',
    reserved: '2',
    time: new Date(Date.now() - 60_000).toISOString(),
  });
  await stock();
  const orderId = await orders.order({
    external: 'order-100',
    key: 'order-100',
    data: { displayNumber: '#100' },
    lines: [
      { external: 'line-1', sku: 'SKU-100', skuKey: 'SKU-100', quantity: '2' },
    ],
  });
  const list = await f.request(f.member, `${f.base}/inventory?view=differs`);
  const position = list.items[0];

  async function issue() {
    const services = createDetectionServices(f.db.ownerUrl);
    t.onTestFinished(() => services.close());
    const corpus = JSON.parse(
      await readFile(
        new URL(
          '../../../packages/exceptions/fixtures/exceptions-v0.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    const keys = [randomUUID(), randomUUID()];
    const time = new Date().toISOString();
    const connections = [orders.erp, orders.store];
    const result = await services.exceptions.ingest(context, {
      key: randomUUID(),
      configuration: defaultConfiguration,
      input: {
        exceptionClass: 'inventory_mismatch',
        facts: {
          ...corpus.bases.inventory_mismatch,
          tenantId: f.org.id,
          evidenceTenantId: f.org.id,
          subjectId: skuId,
          canonicalLocationId: position.locationId,
          connectionIds: connections,
          evidenceRefs: keys,
          leftAvailable: '9',
          rightAvailable: '12',
          leftObservedAt: time,
          rightObservedAt: time,
        },
      },
      evidence: keys.map((key, index) => ({
        key,
        tenantId: f.org.id,
        connectionId: connections[index],
        observedAt: time,
        sourceUpdatedAt: null,
        adapterVersion: 'fixture/1',
        schemaVersion: 1,
        source: {
          provider: index === 0 ? 'jtl' : 'shopify',
          resource: 'sku',
          externalId: index === 0 ? '77' : 'SKU-100',
          scopeKey: '',
        },
        facts: { available: index === 0 ? '9' : '12' },
      })),
    });

    return result.incident.id;
  }

  return { ...orders, stock, skuId, orderId, position, issue };
}
