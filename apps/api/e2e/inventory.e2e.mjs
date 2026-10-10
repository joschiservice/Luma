import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import { inventoryFixture } from './inventory-fixture.mjs';
import { settingsFixture } from './settings-fixture.mjs';

it('compares mapped stock without summing sources and follows scoped related records', async (t) => {
  const f = await settingsFixture(t);
  const stock = await inventoryFixture(t, f);
  const { position } = stock;
  expect(position.differences).toEqual(['available']);
  expect(position.sources.map((s) => s.available).sort()).toEqual(['12', '9']);
  expect(position.sources.every((s) => s.incoming === null)).toBe(true);
  const searched = await f.request(
    f.member,
    `${f.base}/inventory?q=77&connectionId=${stock.erp}`,
  );
  expect(searched.items).toHaveLength(1);
  expect(searched.items[0].sources).toHaveLength(2);
  expect(
    (await f.request(f.member, `${f.base}/inventory?q=Tokyo`)).items,
  ).toHaveLength(1);
  expect(
    (await f.request(f.member, `${f.base}/inventory?q=%25`)).items,
  ).toHaveLength(0);
  const supplierId = randomUUID(),
    poId = randomUUID();
  await f.request(
    f.owner,
    `${f.base}/procurement/suppliers`,
    'POST',
    { id: supplierId, name: 'Supplier', externalReferences: [] },
    200,
  );
  await f.request(
    f.owner,
    `${f.base}/procurement/purchase-orders`,
    'POST',
    {
      id: poId,
      supplierId,
      reference: 'PO-100',
      authority: 'luma',
      externalReferences: [],
      origin: {},
      lines: [
        {
          id: randomUUID(),
          sku: 'SKU-100',
          description: 'Stock',
          quantity: 20,
          unit: 'each',
        },
      ],
    },
    200,
  );
  const issueId = randomUUID();
  for (const [id, scope] of [
    [issueId, stock.erp],
    [randomUUID(), randomUUID()],
  ]) {
    const fingerprint = id.replaceAll('-', '').padEnd(64, '0');
    await f.db.owner.query(
      'INSERT INTO exceptions(id,tenant_id,fingerprint,state,document) VALUES($1,$2,$3,$4,$5)',
      [
        id,
        f.org.id,
        fingerprint,
        'detected',
        {
          id,
          tenantId: f.org.id,
          fingerprint,
          state: 'detected',
          occurrenceCount: 1,
          exceptionClass: 'inventory_mismatch',
          severity: 'high',
          summary: 'Stock differs for SKU-100',
          subject: { subjectKind: 'sku', subjectId: '77', scope: [scope] },
        },
      ],
    );
  }
  const detail = await f.request(
    f.member,
    `${f.base}/inventory/${position.id}`,
  );
  expect(detail.issues.map((issue) => issue.id)).toEqual([issueId]);
  expect(detail.orders[0].id).toBe(stock.orderId);
  expect(detail.purchaseOrders[0].id).toBe(poId);
  expect(detail.history.entries).toHaveLength(3);
  expect(detail.history.entries.filter((e) => e.current)).toHaveLength(2);
  await stock.stock({ location: 'Osaka', amount: null });
  const all = await f.request(
    f.member,
    `${f.base}/inventory?skuId=${stock.skuId}`,
  );
  expect(all.items).toHaveLength(2);
  expect(
    (await f.request(f.member, `${f.base}/inventory?view=differs`)).items,
  ).toHaveLength(1);
  expect(
    (await f.request(f.member, `${f.base}/inventory?view=unknown`)).items,
  ).toHaveLength(2);
  await stock.stock({ unit: 'box', amount: '3' });
  const withUnit = await f.request(
    f.member,
    `${f.base}/inventory?skuId=${stock.skuId}`,
  );
  expect(withUnit.items).toHaveLength(3);
  expect(
    withUnit.items.find((item) => item.unit === 'box').differences,
  ).toEqual([]);
  await stock.stock({
    deleted: true,
    time: new Date(Date.now() + 1000).toISOString(),
  });
  expect(
    (await f.request(f.member, `${f.base}/inventory?view=differs`)).items,
  ).toHaveLength(0);
  await f.request(f.outsider, `${f.base}/inventory`, 'GET', undefined, 404);
  await f.request(
    f.outsider,
    `${f.base}/inventory/${position.id}`,
    'GET',
    undefined,
    404,
  );
  await f.request(
    f.member,
    `${f.base}/inventory/${randomUUID()}`,
    'GET',
    undefined,
    404,
  );
  await f.request(
    f.member,
    `${f.base}/inventory?cursor=broken`,
    'GET',
    undefined,
    400,
  );
  await f.request(null, `${f.base}/inventory`, 'GET', undefined, 401);
});

it('pages positions without duplicates and rejects a cursor for different filters', async (t) => {
  const f = await settingsFixture(t);
  const stock = await inventoryFixture(t, f);
  for (let i = 0; i < 51; i++) {
    await stock.stock({ sku: `SKU-${i + 200}`, external: `SKU-${i + 200}` });
    if (i % 3 === 0)
      await stock.stock({
        connectionId: stock.erp,
        sku: `SKU-${i + 200}`,
        external: `erp-${i + 200}`,
        amount: '9',
      });
  }
  const first = await f.request(f.member, `${f.base}/inventory`);
  expect(first.items).toHaveLength(50);
  expect(first.nextCursor).toBeTruthy();
  const next = await f.request(
    f.member,
    `${f.base}/inventory?cursor=${first.nextCursor}`,
  );
  expect(next.items).toHaveLength(2);
  expect(next.nextCursor).toBeNull();
  expect(new Set([...first.items, ...next.items].map((i) => i.id)).size).toBe(
    52,
  );
  const positions = [...first.items, ...next.items];
  expect(positions.map((item) => item.id)).toEqual(
    positions.map((item) => item.id).sort(),
  );
  const searched = await f.request(f.member, `${f.base}/inventory?q=SKU`);
  expect(searched.items).toEqual(first.items);
  const searchedNext = await f.request(
    f.member,
    `${f.base}/inventory?q=SKU&cursor=${searched.nextCursor}`,
  );
  expect(searchedNext.items).toEqual(next.items);
  const fromErp = await f.request(
    f.member,
    `${f.base}/inventory?connectionId=${stock.erp}`,
  );
  expect(fromErp.items).toEqual(
    positions.filter((item) =>
      item.sources.some((source) => source.connectionId === stock.erp),
    ),
  );
  expect(fromErp.items).toHaveLength(18);
  expect(fromErp.items.every((item) => item.sources.length === 2)).toBe(true);
  expect(fromErp.nextCursor).toBeNull();
  const last = positions.at(-1);
  expect(
    (
      await f.request(
        f.member,
        `${f.base}/inventory?skuId=${last.skuId}&locationId=${last.locationId}`,
      )
    ).items,
  ).toEqual([last]);
  expect(
    (await f.request(f.member, `${f.base}/inventory?view=differs`)).items,
  ).toEqual(fromErp.items);
  const unknown = await f.request(f.member, `${f.base}/inventory?view=unknown`);
  expect(unknown.items).toEqual(first.items);
  const unknownNext = await f.request(
    f.member,
    `${f.base}/inventory?view=unknown&cursor=${unknown.nextCursor}`,
  );
  expect(unknownNext.items).toEqual(next.items);
  await f.request(
    f.member,
    `${f.base}/inventory?q=SKU&cursor=${first.nextCursor}`,
    'GET',
    undefined,
    400,
  );
});
