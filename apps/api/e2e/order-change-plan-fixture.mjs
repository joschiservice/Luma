import assert from 'node:assert/strict';

import { until } from './helpers.mjs';
import { setupSimulator } from './simulator-fixture.mjs';

/**
 * Imports fixture order 1 from Shopify and its JTL import and links the two source orders as an
 * operator would, through `api`, an operator request helper for the workspace. Returns the
 * canonical order, its line's comparison key and the order detail.
 */
export async function linkFixtureOrder(f, api) {
  const tenantId = f.manifest.organizationId;
  const shopify = f.manifest.connections.shopify;
  const jtl = f.manifest.connections.jtl;
  const mapped = async (connectionId, externalId) =>
    (
      await f.db.owner.query(
        "SELECT canonical_id FROM connector_source_mappings WHERE tenant_id=$1 AND connection_id=$2 AND resource='order' AND external_id=$3",
        [tenantId, connectionId, externalId],
      )
    ).rows[0]?.canonical_id;

  // Fixture order 1 exists in the shop and, imported by the integration, in JTL.
  await f.pilot.observe();
  await f.pilot.link();
  const shop = await mapped(shopify, 'gid://shopify/Order/1');
  const erp = await mapped(jtl, '1');
  assert.ok(shop && erp, 'both source orders were imported');
  const request = await api(
    '/identities/links',
    {
      method: 'POST',
      payload: {
        operation: 'link',
        kind: 'order',
        entityId: shop,
        otherId: erp,
        reason: 'The JTL order carries the shop order number',
      },
    },
    202,
  );
  await until(
    async () => {
      await f.pilot.observe({ refresh: false, check: false });

      return (
        (await api(`/identities/links/${request.id}`)).state === 'completed'
      );
    },
    'the order link was applied',
    30_000,
  );
  await f.pilot.observe({ check: false });
  const detail = await api(`/orders/${shop}`);
  const lineKey = detail.sources.find(
    (source) => source.connectionId === shopify,
  )?.lines[0]?.comparisonKey;
  assert.ok(lineKey, 'the line is matched across sources');

  return { shop, lineKey, detail };
}

/**
 * Lets the JTL warehouse start packing fixture order 1: a delivery note whose parcel has no
 * shipping date yet. Reads until Luma reports the work in progress.
 */
export async function packFixtureOrder(f, api, shop) {
  const jtl = f.manifest.connections.jtl;
  await f.call('runs/operations/control', {
    action: 'command',
    instance: 'jtl',
    command: { kind: 'ship', id: '1', warehouse: '1', packing: true },
  });
  await until(
    async () => {
      await f.pilot.observe({ check: false });

      return (await api(`/orders/${shop}`)).fulfillments.some(
        (work) => work.connectionId === jtl && work.status === 'processing',
      );
    },
    'JTL reported the delivery note as fulfilment in progress',
    30_000,
  );
}

/**
 * Starts the simulator pilot, links the fixture order 1 in Shopify with its JTL import and
 * returns the linked order, its line's comparison key and an API helper for the operator.
 * `packing()` lets the JTL warehouse start packing the order and reads it again.
 */
export async function linkedOrderFixture(t, origin = 'http://127.0.0.1:3000') {
  const f = await setupSimulator(t, { origin });
  const tenantId = f.manifest.organizationId;
  const shopify = f.manifest.connections.shopify;
  const jtl = f.manifest.connections.jtl;
  const signIn = await f.pilot.app.inject({
    method: 'POST',
    url: '/auth/sign-in/email',
    headers: { origin },
    payload: { email: 'pilot-operator@example.test', password: f.password },
  });
  assert.equal(signIn.statusCode, 200, signIn.body);
  const cookie = signIn.cookies
    .map(({ name, value }) => `${name}=${value}`)
    .join('; ');
  const api = async (url, options = {}, status = 200) => {
    const response = await f.pilot.app.inject({
      url: `/v1/organizations/${tenantId}${url}`,
      headers: { cookie, origin },
      ...options,
    });
    assert.equal(response.statusCode, status, response.body);

    return response.json();
  };
  const { shop, lineKey, detail } = await linkFixtureOrder(f, api);

  return {
    f,
    api,
    cookie,
    tenantId,
    shopify,
    jtl,
    shop,
    lineKey,
    detail,
    /** The JTL warehouse creates a delivery note whose parcel is still being packed. */
    packing: () => packFixtureOrder(f, api, shop),
  };
}
