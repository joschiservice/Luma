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

// The ANZ profile is Luma's realistic Cin7 setup: AUD base currency, NZD sales from the NZ shop
// and wholesale sales that exist only in Cin7. History is skipped to keep the import short.
test('an ANZ merchant on Cin7 imports foreign-currency shop sales and unlinked wholesale sales', async (t) => {
  const f = await setupSimulator(t, {
    profile: 'anz-lifestyle',
    historyDays: 0,
  });
  const connectionId = f.manifest.connections.cin7;
  expect(connectionId).toBeDefined();
  const cookie = await operatorCookie(f);
  const base = `/v1/organizations/${f.manifest.organizationId}`;

  const [variant] = (
    await f.call(
      'runs/operations/records/shopify-nz?kind=ProductVariant&limit=1',
    )
  ).items;
  await f.call('runs/operations/control', {
    action: 'order',
    shop: 'shopify-nz',
    lines: [{ sku: variant.data.sku, quantity: 1 }],
  });
  await f.call('runs/operations/control', { action: 'wholesale-order' });
  // The order integration imports shop orders into Cin7 within minutes.
  await f.call('runs/operations/control', {
    action: 'advance',
    milliseconds: 30 * 60_000,
  });
  await f.pilot.observe({ check: false });

  // Luma's order for a Cin7 sale, found through the sale GUID it imported.
  const sales = (
    await f.call('runs/operations/records/cin7?kind=sales-order&limit=100')
  ).items.map((item) => item.data);
  const lumaOrder = async (sale) => {
    const { rows } = await f.db.owner.query(
      "SELECT m.canonical_id,s.document FROM connector_source_mappings m JOIN orders_projections p ON p.entity_id=m.canonical_id AND p.connection_id=m.connection_id JOIN orders_snapshots s ON s.id=p.snapshot_id WHERE m.connection_id=$1 AND m.resource='order' AND m.external_id=$2",
      [connectionId, `c1700001-0000-4000-8000-${sale.id.padStart(12, '0')}`],
    );
    expect(rows).toHaveLength(1);

    return { entityId: rows[0].canonical_id, document: rows[0].document };
  };
  const nzSale = sales.find((sale) => sale.externalNumber?.startsWith('NZ'));
  const wholesaleSale = sales.find((sale) => !sale.externalNumber);
  expect(nzSale).toMatchObject({ currency: 'NZD', taxRate: 15 });
  expect(wholesaleSale).toMatchObject({ currency: 'AUD', taxRate: 10 });
  const nz = await lumaOrder(nzSale);
  const wholesale = await lumaOrder(wholesaleSale);
  // Totals keep the sale's own currency; Cin7's base currency is not Luma's order currency.
  expect(JSON.stringify(nz.document)).toContain('"NZD"');
  expect(JSON.stringify(wholesale.document)).toContain('"AUD"');

  const suggestions = async (entityId) => {
    const response = await f.pilot.app.inject({
      method: 'GET',
      url: `${base}/identities/order/${entityId}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);

    return response.json().suggestions.map((item) => item.reason);
  };
  expect(await suggestions(nz.entityId)).toContainEqual(
    expect.stringMatching(
      /^Source external order number “NZ.+” matches Shopify$/,
    ),
  );
  // A wholesale sale has no shop counterpart; Luma suggests no link and opens no case.
  expect(await suggestions(wholesale.entityId)).toEqual([]);
  const actor = await f.pilot.operator();
  const cases = await f.pilot.detection.exceptions.list(actor);
  expect(
    cases.filter((item) => JSON.stringify(item).includes(wholesale.entityId)),
  ).toEqual([]);
}, 600_000);
