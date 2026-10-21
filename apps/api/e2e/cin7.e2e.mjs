import { expect, test } from 'vitest';

import { setupSimulator } from './simulator-fixture.mjs';

/** Signs in as the pilot operator on the in-process pilot API. */
async function operatorCookie(f) {
  const response = await f.pilot.app.inject({
    method: 'POST',
    url: '/auth/sign-in/email',
    headers: { origin: 'http://127.0.0.1:3000' },
    payload: { email: 'pilot-operator@example.test', password: f.password },
  });
  expect(response.statusCode).toBe(200);

  return response.cookies
    .map(({ name, value }) => `${name}=${value}`)
    .join('; ');
}

test('a merchant on Cin7 Core imports through the read-only Cin7 app and links orders to Shopify', async (t) => {
  const f = await setupSimulator(t, { erp: 'cin7' });
  const connectionId = f.manifest.connections.cin7;
  const cookie = await operatorCookie(f);
  const base = `/v1/organizations/${f.manifest.organizationId}`;

  const connections = await f.pilot.app.inject({
    method: 'GET',
    url: `${base}/connections`,
    headers: { cookie },
  });
  expect(connections.statusCode).toBe(200);
  const cin7 = connections
    .json()
    .items.find((item) => item.id === connectionId);
  expect(cin7).toMatchObject({ status: 'active' });
  expect([...cin7.granted].sort()).toEqual([
    'customers.read',
    'fulfillment.read',
    'inventory.read',
    'orders.read',
    'products.read',
    'purchase-orders.read',
    'returns.read',
    'suppliers.read',
  ]);

  await f.pilot.observe({ check: false });
  const counts = await f.db.owner.query(
    'SELECT s.kind,count(*)::int AS count FROM orders_projections p JOIN orders_snapshots s ON s.id=p.snapshot_id WHERE p.connection_id=$1 GROUP BY s.kind ORDER BY s.kind',
    [connectionId],
  );
  expect(counts.rows.find((row) => row.kind === 'order')?.count).toBe(2);
  // Stock is reported per Cin7 location, never as an all-warehouses total.
  const locations = await f.db.owner.query(
    "SELECT DISTINCT external_id FROM connector_source_mappings WHERE connection_id=$1 AND resource='location'",
    [connectionId],
  );
  expect(locations.rows.length).toBeGreaterThan(0);
  for (const row of locations.rows)
    expect(row.external_id).toMatch(/^c1700003-/);

  // Exact shop references are linked automatically rather than left as manual suggestions.
  const orders = await f.db.owner.query(
    "SELECT DISTINCT p.entity_id FROM orders_projections p JOIN orders_snapshots s ON s.id=p.snapshot_id WHERE p.connection_id=$1 AND s.kind='order'",
    [connectionId],
  );
  for (const { entity_id: entityId } of orders.rows) {
    const response = await f.pilot.app.inject({
      method: 'GET',
      url: `${base}/identities/order/${entityId}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().suggestions).toEqual([]);
    const linked = await f.db.owner.query(
      'SELECT 1 FROM orders_projections WHERE tenant_id=$1 AND entity_id=$2 AND connection_id=$3',
      [f.manifest.organizationId, entityId, f.manifest.connections.shopify],
    );
    expect(linked.rowCount).toBe(1);
  }
}, 120_000);
