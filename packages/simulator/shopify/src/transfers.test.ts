import { expect, it } from 'vitest';

import { createShop } from './test-support/shop.js';

it('enforces transfer and shipment grants independently for collections and node reads', async () => {
  const shop = createShop({ scopes: ['read_inventory_transfers'] });
  expect(
    await shop.query('query { inventoryTransfers(first: 5) { nodes { id } } }'),
  ).toMatchObject({ data: { inventoryTransfers: { nodes: [] } } });
  expect(
    await shop.query('query { inventoryShipments(first: 5) { nodes { id } } }'),
  ).toMatchObject({ errors: [{ extensions: { code: 'ACCESS_DENIED' } }] });
  expect(
    await shop.query(
      'query { node(id: "gid://shopify/InventoryShipment/1") { id } }',
    ),
  ).toMatchObject({ errors: [{ extensions: { code: 'ACCESS_DENIED' } }] });
  const missing = createShop({ scopes: [] });
  expect(
    await missing.query(
      'query { inventoryTransfer(id: "gid://shopify/InventoryTransfer/1") { id } }',
    ),
  ).toMatchObject({ errors: [{ extensions: { code: 'ACCESS_DENIED' } }] });
});
