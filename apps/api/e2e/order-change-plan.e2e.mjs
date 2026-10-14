import { expect, test } from 'vitest';

import { linkedOrderFixture } from './order-change-plan-fixture.mjs';

test('plans a Shopify quantity change across Shopify and JTL before and after the warehouse starts packing', async (t) => {
  const { f, api, shopify, jtl, shop, lineKey, detail, packing } =
    await linkedOrderFixture(t);
  expect(detail.sources.map((source) => source.connectionId).sort()).toEqual(
    [shopify, jtl, f.manifest.connections.starshipit].sort(),
  );
  const plan = async () =>
    (
      await api(
        `/orders/${shop}/change-plan?kind=quantity&lineKey=${lineKey}&quantity=1`,
      )
    ).plans[0];

  // Before picking: Luma can change the Shopify line; a person updates JTL.
  const before = await plan();
  expect(before.change).toMatchObject({
    kind: 'quantity',
    from: '2',
    to: '1',
  });
  expect(before.safety).toEqual({ state: 'safe', reasons: [] });
  // JTL reports ordered units only, so whether it shows the change stays unknown.
  expect(
    before.acknowledgements.map((item) => [item.connectionId, item.state]),
  ).toEqual(
    expect.arrayContaining([
      [shopify, 'differs'],
      [jtl, 'unknown'],
    ]),
  );
  expect(before.steps).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        performer: 'luma',
        connectionId: shopify,
        capability: 'orders.quantity.edit',
        executable: true,
        viewerCanRequest: true,
        handoff: {
          orderExternalId: 'gid://shopify/Order/1',
          lines: [
            { externalId: expect.stringMatching(/LineItem/), quantity: '1' },
          ],
        },
      }),
      expect.objectContaining({
        performer: 'person',
        role: 'operator',
        connectionId: jtl,
      }),
    ]),
  );

  // The warehouse starts packing in JTL: a delivery note without a shipping date.
  await packing();
  const after = await plan();
  expect(after.safety).toEqual({
    state: 'unsafe',
    reasons: [{ code: 'work_started', connectionId: jtl, lineKey }],
  });
  expect(after.shipped).toEqual([
    expect.objectContaining({ lineKey, units: '0', basis: 'authority' }),
  ]);
  expect(
    after.steps.map((step) => [step.performer, step.action, step.role]),
  ).toEqual(
    expect.arrayContaining([
      ['person', 'confirm_picking', 'warehouse'],
      ['luma', 'update_quantity', null],
      ['person', 'update_quantity', 'operator'],
      ['person', 'escalate_unsafe', 'operator'],
    ]),
  );
  expect(after.steps[0].connectionId).toBe(jtl);
  expect(after.steps[1]).toMatchObject({
    executable: false,
    blockedBy: 'unsafe',
  });

  // Without a proposal the plan covers detected differences only; this order has none.
  expect((await api(`/orders/${shop}/change-plan`)).plans).toEqual([]);
  await api(
    `/orders/${shop}/change-plan?kind=quantity&lineKey=${lineKey}`,
    {},
    400,
  );
}, 180_000);
