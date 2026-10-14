import { randomUUID } from 'node:crypto';

import { builtInMembership, makeTenantContext } from '@luma/identity';
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
      dataRegion: 'AU',
      status: 'active',
    },
    builtInMembership(
      { id: randomUUID(), organizationId: tenantId, userId },
      'owner',
    ),
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
  const competing = await Promise.allSettled(
    [1, 2].map(() =>
      capabilities.createOrder(context, {
        ...request,
        id: randomUUID(),
        origin: { workflowRunId: randomUUID() },
        lines: [{ ...request.lines[0], id: randomUUID(), sku: 'SKU-2' }],
      }),
    ),
  );
  expect(
    competing.filter((result) => result.status === 'fulfilled'),
  ).toHaveLength(1);
  expect(
    competing.filter((result) => result.status === 'rejected'),
  ).toHaveLength(1);
  expect((await service.orders(context)).items).toHaveLength(2);
});

it('lets procurement readers browse but requires procurement.manage to change records', async () => {
  const tenantId = randomUUID();
  const organization = {
    id: tenantId,
    name: 'Scenario',
    slug: 'scenario',
    dataRegion: 'AU',
    status: 'active',
  } as const;
  const contextFor = (role: 'admin' | 'member') => {
    const userId = randomUUID();

    return makeTenantContext(
      { userId, sessionId: randomUUID() },
      organization,
      builtInMembership(
        { id: randomUUID(), organizationId: tenantId, userId },
        role,
      ),
      randomUUID(),
    );
  };
  const admin = contextFor('admin');
  const member = contextFor('member');
  const service = createSimulatedProcurement({
    refreshContext: async (context) => context,
    now: () => new Date(Date.UTC(2026, 0, 1)),
    id: randomUUID,
  });
  const supplierId = randomUUID();
  await service.createSupplier(admin, {
    id: supplierId,
    name: 'Northstar',
    externalReferences: [],
  });

  expect(await service.suppliers(admin)).toMatchObject({ canManage: true });
  expect(await service.suppliers(member)).toMatchObject({
    canManage: false,
    items: [{ id: supplierId }],
  });
  await expect(
    service.createSupplier(member, {
      id: randomUUID(),
      name: 'Southwind',
      externalReferences: [],
    }),
  ).rejects.toMatchObject({ statusCode: 403 });
});
