import { randomUUID } from 'node:crypto';

import { makeTenantContext } from '@luma/identity';
import { expect, it } from 'vitest';

import { createProcurementCapabilities } from './capabilities.js';
import { createSimulatedProcurement } from './simulator.js';

it('evaluates supplier lookup, open orders, creation, transition, retries and verification deterministically', async () => {
  const tenantId = randomUUID();
  const userId = randomUUID();
  const context = makeTenantContext(
    { userId, sessionId: randomUUID() },
    {
      id: tenantId,
      name: 'Scenario',
      slug: 'scenario',
      dataRegion: 'EU',
      status: 'active',
    },
    { id: randomUUID(), organizationId: tenantId, userId, role: 'owner' },
    randomUUID(),
  );
  let tick = 0;
  const service = createSimulatedProcurement({
    refreshContext: async () => context,
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
    id: randomUUID,
  });
  const capabilities = createProcurementCapabilities(service);
  const supplierId = randomUUID();
  await service.createSupplier(context, {
    id: supplierId,
    name: 'Northstar',
    externalReferences: [],
  });
  expect(
    (await capabilities.lookupSupplier(context, { supplierId }))?.name,
  ).toBe('Northstar');
  const orderId = randomUUID();
  const request = {
    id: orderId,
    supplierId,
    reference: 'PO-1',
    authority: 'luma',
    externalReferences: [],
    origin: {},
    lines: [
      {
        id: randomUUID(),
        sku: 'SKU-1',
        description: 'Widget',
        quantity: 12,
        unit: 'each',
      },
    ],
  };
  const draft = await capabilities.createOrder(context, request);
  expect(await capabilities.createOrder(context, request)).toEqual(draft);
  expect(
    await capabilities.verifyOrder(context, orderId, {
      status: 'draft',
      revision: 1,
      commandId: orderId,
    }),
  ).toMatchObject({ passed: true });
  expect(await capabilities.lookupOpenOrders(context, {})).toEqual([]);
  const transitionCommandId = randomUUID();
  const opened = await capabilities.transitionOrder(context, {
    purchaseOrderId: orderId,
    id: transitionCommandId,
    expectedRevision: 1,
    status: 'open',
    reason: 'Reviewed',
  });
  expect(opened.revision).toBe(2);
  expect(
    (await capabilities.lookupOpenOrders(context, { supplierId })).map(
      (order) => order.id,
    ),
  ).toEqual([orderId]);
  expect(
    await capabilities.verifyOrder(context, orderId, {
      status: 'open',
      revision: 2,
      commandId: transitionCommandId,
    }),
  ).toMatchObject({ passed: true });
  expect(
    await capabilities.verifyOrder(context, orderId, {
      status: 'open',
      revision: 2,
      commandId: randomUUID(),
    }),
  ).toMatchObject({ passed: false });
  expect(
    (await service.detail(context, orderId)).history.map((event) => event.to),
  ).toEqual(['draft', 'open']);
});
