import { createCommerceServices } from '@luma/application-runtime';
import { expect, test } from 'vitest';

import { starshipitOperationsFixture } from './starshipit-operations-fixture.mjs';

test('explicit line links require a shared order, persist across fresh reads and can be safely retried or undone', async (t) => {
  const f = await starshipitOperationsFixture(t);
  const shopify = f.manifest.connections.shopify;
  const starshipit = f.manifest.connections.starshipit;
  const initialShop = await f.detail();
  const initialShipping = await f.api(`/orders/${f.shipping}`);
  const request = {
    operation: 'link',
    kind: 'order_line',
    entityId: initialShop.sources[0].lines[0].id,
    otherId: initialShipping.sources[0].lines[0].id,
    reason: 'Exact merchant confirmation',
  };
  await f.api('/identities/links', {
    method: 'POST',
    body: request,
    status: 422,
  });
  await f.api('/identities/links', {
    method: 'POST',
    body: request,
    actor: 'warehouse',
    status: 403,
  });
  await f.link('order', f.shop, f.shipping);
  const detail = await f.detail();
  const left = detail.sources.find((source) => source.connectionId === shopify)
    .lines[0];
  const right = detail.sources.find(
    (source) => source.connectionId === starshipit,
  ).lines[0];
  expect(right.skuId).toBeNull();
  expect(right.comparisonKey).toBeNull();
  const identity = await f.api(`/identities/order_line/${left.id}`);
  expect(identity.entity).toMatchObject({ orderId: f.shop, unit: 'each' });
  expect(identity.suggestions.map((item) => item.id)).toContain(right.id);
  await f.link('order_line', left.id, right.id);
  const matched = await f.detail();
  expect(
    matched.sources.every((source) => source.lines[0].id === left.id),
  ).toBe(true);
  expect(
    matched.sources.every(
      (source) => source.lines[0].comparisonKey === left.id,
    ),
  ).toBe(true);
  const commerce = createCommerceServices(f.db.runtimeUrl);
  t.onTestFinished(commerce.close);
  const actor = await f.pilot.operator();
  await expect(
    commerce.ingestion.link(
      actor,
      'order_line',
      left.id,
      right.id,
      'Retry after a worker restart',
    ),
  ).resolves.toEqual({ moved: 0 });
  await f.pilot.observe({ check: false });
  expect(
    (await f.detail()).sources.every(
      (source) => source.lines[0].id === left.id,
    ),
  ).toBe(true);
  const undone = await f.api('/identities/links', {
    method: 'POST',
    status: 202,
    body: {
      operation: 'unlink',
      kind: 'order_line',
      entityId: left.id,
      connectionId: starshipit,
      reason: 'Merchant corrected a mistaken line confirmation',
    },
  });
  await f.complete(undone);
  await f.pilot.observe({ check: false });
  const separated = await f.detail();
  expect(
    separated.sources.find((source) => source.connectionId === shopify).lines[0]
      .id,
  ).toBe(left.id);
  expect(
    separated.sources.find((source) => source.connectionId === starshipit)
      .lines[0].id,
  ).not.toBe(left.id);
  expect(
    separated.sources.find((source) => source.connectionId === starshipit)
      .lines[0].comparisonKey,
  ).toBeNull();
  const revisions = (
    await f.db.owner.query(
      "SELECT method,reason,actor_id FROM connector_mapping_revisions WHERE tenant_id=$1 AND resource='order_line'",
      [f.tenantId],
    )
  ).rows;
  expect(
    revisions.some((entry) => entry.reason.includes('Merchant confirmed')),
  ).toBe(true);
  expect(
    revisions.some((entry) => entry.reason.includes('corrected a mistaken')),
  ).toBe(true);
});
