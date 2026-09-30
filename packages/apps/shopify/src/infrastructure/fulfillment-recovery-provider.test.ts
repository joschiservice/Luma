import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { TenantContext } from '@luma/identity';
import { buildSchema, parse as parseGraphql, validate } from 'graphql';
import { describe, expect, it, vi } from 'vitest';

import {
  fulfillmentProgress,
  recoveryBlocker,
} from '../domain/fulfillment-recovery.js';
import {
  createFulfillmentProvider,
  type RecoveryEvidence,
} from './fulfillment-recovery-provider.js';

const schema = buildSchema(
  readFileSync(
    new URL('./fixtures/admin-2026-07.graphql', import.meta.url),
    'utf8',
  ),
);

const gid = (kind: string, value = 1) => `gid://shopify/${kind}/${value}`;

function fixture() {
  const node = {
    id: gid('FulfillmentOrder'),
    updatedAt: '2026-09-29T00:00:00Z',
    status: 'ON_HOLD',
    requestStatus: 'UNSUBMITTED',
    order: { id: gid('Order') },
    assignedLocation: { name: 'Tokyo', location: { id: gid('Location') } },
    supportedActions: [
      { action: 'RELEASE_HOLD' },
      { action: 'MOVE' },
      { action: 'MARK_AS_OPEN' },
    ],
    fulfillmentHolds: [1, 2].map((value) => ({
      id: gid('FulfillmentHold', value),
      reason: 'OTHER',
      heldByRequestingApp: true,
    })),
    lineItems: {
      nodes: [
        {
          lineItem: { id: gid('LineItem') },
          remainingQuantity: 2,
          totalQuantity: 2,
        },
      ],
      pageInfo: { hasNextPage: false },
    },
  };
  const locations = {
    nodes: [
      {
        location: { id: gid('Location', 2), name: 'Osaka' },
        movable: true,
        unavailableLineItemsCount: { count: 0, precision: 'EXACT' },
      },
    ],
    pageInfo: { hasNextPage: false },
  };
  const mutations: { query: string; variables: Record<string, unknown> }[] = [];
  let timeout = false;
  let userErrors = false;
  const transport = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    expect(validate(schema, parseGraphql(body.query))).toEqual([]);
    if (body.query.startsWith('mutation')) {
      mutations.push(body);
      if (timeout) throw new Error('connection lost');

      return Response.json({
        data: {
          result: {
            resultOrder: userErrors ? null : { id: node.id, order: node.order },
            userErrors: userErrors
              ? [{ field: ['id'], message: 'Not eligible' }]
              : [],
          },
        },
      });
    }

    return Response.json({
      data: {
        node: body.query.includes('LumaFulfillmentLocations')
          ? { locationsForMove: locations }
          : node,
      },
    });
  });
  const record = vi.fn<(evidence: RecoveryEvidence) => Promise<void>>(
    async () => {},
  );
  const tenantId = randomUUID();
  const connectionId = randomUUID();
  const provider = createFulfillmentProvider({
    tenantId,
    connectionId,
    shop: 'recovery.myshopify.com',
    accessToken: async () => 'test-token',
    fetch: transport,
    record,
  });
  const context = {
    tenant: { tenantId } as TenantContext,
    connectionId,
    provider: 'shopify',
    idempotencyKey: 'recovery-1',
  };

  return {
    node,
    locations,
    provider,
    context,
    mutations,
    record,
    timeout: () => {
      timeout = true;
    },
    reject: () => {
      userErrors = true;
    },
  };
}

describe('Shopify fulfillment recovery', () => {
  it('releases only the selected hold and records acceptance separately from progress', async () => {
    const f = fixture();
    const before = await f.provider.read(gid('Order'), gid('FulfillmentOrder'));
    const handler = f.provider.capabilities['fulfillment.hold.release'];
    const result = await handler.run(
      f.context,
      handler.parseInput({
        orderId: before.orderId,
        fulfillmentOrderId: before.fulfillmentOrderId,
        expectedRevision: before.revision,
        holdId: gid('FulfillmentHold', 2),
      }),
    );
    expect(result.status).toBe('accepted');
    expect(f.mutations[0]!.variables.holdIds).toEqual([
      gid('FulfillmentHold', 2),
    ]);
    expect(f.record).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'acceptance' }),
    );
    const unchanged = await f.provider.read(
      gid('Order'),
      gid('FulfillmentOrder'),
    );
    expect(fulfillmentProgress(before, unchanged)).toBe(false);
    f.node.lineItems.nodes[0]!.remainingQuantity = 1;
    expect(
      fulfillmentProgress(
        before,
        await f.provider.read(gid('Order'), gid('FulfillmentOrder')),
      ),
    ).toBe(true);
  });

  it('withholds a changed revision, incomplete reads, unavailable destinations and removed holds', async () => {
    const f = fixture();
    const before = await f.provider.read(gid('Order'), gid('FulfillmentOrder'));
    f.node.fulfillmentHolds.pop();
    await expect(
      f.provider.capabilities['fulfillment.hold.release'].run(f.context, {
        orderId: before.orderId,
        fulfillmentOrderId: before.fulfillmentOrderId,
        expectedRevision: before.revision,
        holdId: gid('FulfillmentHold', 2),
      }),
    ).rejects.toMatchObject({
      failure: { code: 'conflict', dispatch: 'not_dispatched' },
    });
    expect(f.mutations).toHaveLength(0);
    expect(
      recoveryBlocker(
        { ...before, complete: false },
        { capability: 'fulfillment.open' },
        ['fulfillment.open'],
      ),
    ).toMatch(/incomplete/);
    expect(
      recoveryBlocker(
        before,
        { capability: 'fulfillment.move', locationId: gid('Location', 3) },
        ['fulfillment.move'],
      ),
    ).toMatch(/cannot move/);
    expect(
      recoveryBlocker(before, { capability: 'fulfillment.open' }, []),
    ).toMatch(/write access/);
    expect(
      recoveryBlocker(
        { ...before, requestStatus: 'ACCEPTED' },
        { capability: 'fulfillment.move', locationId: gid('Location', 2) },
        ['fulfillment.move'],
      ),
    ).toMatch(/cancellation/);
  });

  it.each(['fulfillment.open', 'fulfillment.move'] as const)(
    'dispatches %s with a typed exact target',
    async (capability) => {
      const f = fixture();
      const before = await f.provider.read(
        gid('Order'),
        gid('FulfillmentOrder'),
      );
      await f.provider.capabilities[capability].run(f.context, {
        orderId: before.orderId,
        fulfillmentOrderId: before.fulfillmentOrderId,
        expectedRevision: before.revision,
        ...(capability === 'fulfillment.move'
          ? { locationId: gid('Location', 2) }
          : {}),
      });
      expect(f.mutations).toHaveLength(1);
      expect(f.mutations[0]!.variables.id).toBe(gid('FulfillmentOrder'));
      if (capability === 'fulfillment.move')
        expect(f.mutations[0]!.variables.newLocationId).toBe(
          gid('Location', 2),
        );
    },
  );

  it('never retries an uncertain mutation and rejects foreign parent or tenant references', async () => {
    const f = fixture();
    const before = await f.provider.read(gid('Order'), gid('FulfillmentOrder'));
    f.timeout();
    await expect(
      f.provider.capabilities['fulfillment.open'].run(f.context, {
        orderId: before.orderId,
        fulfillmentOrderId: before.fulfillmentOrderId,
        expectedRevision: before.revision,
      }),
    ).rejects.toMatchObject({
      failure: { effect: 'unknown', retry: 'reconcile' },
    });
    expect(f.mutations).toHaveLength(1);
    await expect(
      f.provider.read(gid('Order', 2), gid('FulfillmentOrder')),
    ).rejects.toMatchObject({ failure: { code: 'not_found' } });
    await expect(
      f.provider.capabilities['fulfillment.open'].run(
        { ...f.context, tenant: { tenantId: randomUUID() } as TenantContext },
        {
          orderId: before.orderId,
          fulfillmentOrderId: before.fulfillmentOrderId,
          expectedRevision: before.revision,
        },
      ),
    ).rejects.toMatchObject({ failure: { code: 'permission_denied' } });
  });

  it('does not treat user errors, missing lines or a moved order identity as verified progress', async () => {
    const f = fixture();
    const before = await f.provider.read(gid('Order'), gid('FulfillmentOrder'));
    f.reject();
    await expect(
      f.provider.capabilities['fulfillment.open'].run(f.context, {
        orderId: before.orderId,
        fulfillmentOrderId: before.fulfillmentOrderId,
        expectedRevision: before.revision,
      }),
    ).rejects.toMatchObject({ failure: { effect: 'none', retry: 'never' } });
    expect(fulfillmentProgress(before, { ...before, lines: [] })).toBe(false);
    expect(
      fulfillmentProgress(before, {
        ...before,
        fulfillmentOrderId: gid('FulfillmentOrder', 2),
      }),
    ).toBe(false);
    expect(
      f.record.mock.calls.some(
        ([value]) =>
          (value as { kind?: string } | undefined)?.kind === 'acceptance',
      ),
    ).toBe(false);
  });
});
