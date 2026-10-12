import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import { syncFixture } from './sync-fixture.mjs';

it('reports import progress and coverage, and lets only managers control syncs', async (t) => {
  const f = await syncFixture(t);
  const overview = await f.request(f.member, `${f.base}/sync`);
  expect(overview.canManage).toBe(false);
  const store = overview.connections.find(
    (connection) => connection.connectionId === f.store,
  );
  expect(store.recordTypes.map((item) => item.recordType)).toEqual([
    'orders',
    'fulfillments',
    'products',
    'inventory',
    'customers',
    'returns',
    'inventory_transfers',
    'inventory_shipments',
  ]);
  expect(store.recordTypes[0]).toMatchObject({
    availability: 'granted',
    stream: {
      id: f.stream,
      status: 'importing',
      scan: { kind: 'backfill', records: 50, total: 120 },
      records: { total: 50, current: 50 },
      coverage: { historyRequirement: 'read_all_orders' },
    },
  });
  expect(store.recordTypes[4]).toEqual({
    recordType: 'customers',
    availability: 'not_requested',
    stream: null,
  });
  // A connection set up before returns existed shows them as not requested.
  expect(store.recordTypes[5]).toEqual({
    recordType: 'returns',
    availability: 'not_requested',
    stream: null,
  });

  expect(store.recordTypes.slice(6)).toEqual([
    {
      recordType: 'inventory_transfers',
      availability: 'not_requested',
      stream: null,
    },
    {
      recordType: 'inventory_shipments',
      availability: 'not_requested',
      stream: null,
    },
  ]);

  await f.db.owner.query(
    `UPDATE commerce_sync_streams SET recent_history_from=now()-interval '30 days',
    recent_history_completed_at=now(),scan_waiting=true WHERE tenant_id=$1 AND id=$2`,
    [f.org.id, f.stream],
  );
  const recent = await f.request(f.member, `${f.base}/sync`);
  const recentStream = recent.connections.find(
    (connection) => connection.connectionId === f.store,
  ).recordTypes[0].stream;
  expect(recentStream).toMatchObject({
    phase: 'backfill',
    backfillCompletedAt: null,
    scan: { waitingForExport: true },
  });
  expect(recentStream.coverage.recentFrom).toBeTruthy();
  expect(recentStream.coverage.recentCompletedAt).toBeTruthy();

  await f.request(
    f.member,
    `${f.base}/sync/${f.stream}/commands`,
    'POST',
    { command: 'pause' },
    403,
  );
  await f.request(f.outsider, `${f.base}/sync`, 'GET', undefined, 404);
  const paused = await f.request(
    f.owner,
    `${f.base}/sync/${f.stream}/commands`,
    'POST',
    { command: 'pause' },
  );
  expect(paused).toMatchObject({ status: 'paused', paused: true });
  await f.request(
    f.owner,
    `${f.base}/sync/${randomUUID()}/commands`,
    'POST',
    { command: 'resume' },
    404,
  );
});

it('suggests SKUs that share a code and records link requests for managers', async (t) => {
  const f = await syncFixture(t);
  const shopSku = f.skus[f.store];
  const erpSku = f.skus[f.erp];
  const identity = await f.request(
    f.member,
    `${f.base}/identities/sku/${shopSku}`,
  );
  expect(identity).toMatchObject({
    entity: { id: shopSku, kind: 'sku', label: 'LINEN-M' },
    canManage: false,
    sources: [{ connectionId: f.store, codes: ['LINEN-M'] }],
    suggestions: [{ id: erpSku, reason: 'Same SKU code “LINEN-M”' }],
  });
  const body = {
    operation: 'link',
    kind: 'sku',
    entityId: shopSku,
    otherId: erpSku,
    reason: 'Same shirt',
  };
  await f.request(f.member, `${f.base}/identities/links`, 'POST', body, 403);
  const request = await f.request(
    f.owner,
    `${f.base}/identities/links`,
    'POST',
    body,
    202,
  );
  expect(request).toMatchObject({ state: 'requested', otherId: erpSku });
  expect(
    await f.request(f.member, `${f.base}/identities/links/${request.id}`),
  ).toMatchObject({ id: request.id, state: 'requested' });
  await f.request(
    f.owner,
    `${f.base}/identities/links`,
    'POST',
    {
      operation: 'unlink',
      kind: 'sku',
      entityId: shopSku,
      connectionId: f.erp,
      reason: 'Not linked',
    },
    422,
  );
});
