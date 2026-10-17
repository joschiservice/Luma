import { randomUUID } from 'node:crypto';

import type { EffectIntent } from '@luma/connections';
import { builtInMembership, makeTenantContext } from '@luma/identity';
import { notFound } from '@luma/platform';
import type { ProcurementService } from '@luma/procurement';
import { describe, expect, it, vi } from 'vitest';

import { createProcurementEffects } from './procurement-effects.js';

const tenantId = randomUUID();
const supplierId = randomUUID();
const orderId = randomUUID();
const userId = randomUUID();
const context = makeTenantContext(
  { userId, sessionId: randomUUID() },
  {
    id: tenantId,
    name: 'Test',
    slug: 'test',
    dataRegion: 'AU',
    status: 'active',
  },
  builtInMembership(
    { id: randomUUID(), organizationId: tenantId, userId },
    'owner',
  ),
  randomUUID(),
);
const line = {
  id: randomUUID(),
  sku: 'SKU-1',
  description: 'Widget',
  quantity: 12,
  unit: 'each',
};

function intent(overrides: Partial<EffectIntent> = {}): EffectIntent {
  return {
    tenantId,
    connectionId: tenantId,
    capability: 'procurement.purchase-order.create',
    capabilityVersion: '1',
    target: { kind: 'purchase_order', id: orderId },
    parameters: {
      supplierId,
      reference: 'PO-1',
      lines: JSON.stringify([line]),
    },
    preconditions: {
      evidenceRefs: [],
      validUntil: new Date(Date.now() + 60_000).toISOString(),
    },
    expectedPostcondition: { status: 'draft' },
    ...overrides,
  };
}

describe('procurement effects', () => {
  it('binds a typed Luma-owned create and verifies the authoritative order', async () => {
    const order = {
      id: orderId,
      tenantId,
      supplierId,
      reference: 'PO-1',
      lines: [line],
      origin: {},
      authority: 'luma',
      status: 'draft',
      revision: 1,
      supplierName: 'Northstar',
      externalReferences: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const service = {
      supplier: vi.fn().mockResolvedValue({
        id: supplierId,
        tenantId,
        name: 'Northstar',
        externalReferences: [],
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
      detail: vi
        .fn()
        .mockRejectedValueOnce(notFound('missing'))
        .mockResolvedValue({
          order,
          canManage: true,
          allowedTransitions: ['open'],
          history: [
            {
              id: randomUUID(),
              commandId: orderId,
              occurredAt: '2026-01-01T00:00:00.000Z',
              actorId: userId,
              from: null,
              to: 'draft',
              revision: 1,
              reason: 'Created',
            },
          ],
        }),
      createOrder: vi.fn().mockResolvedValue(order),
    } as unknown as ProcurementService;
    const action = intent();
    const adapter = await createProcurementEffects(service).resolve(
      context,
      action,
    );
    expect(adapter).not.toBeNull();
    expect(adapter?.minimumRisk).toBe('medium');
    expect(await adapter?.checkPreconditions(action)).toBe(true);
    expect(await adapter?.execute(action, 'retry-key')).toMatchObject({
      evidenceRefs: [orderId],
    });
    expect(service.createOrder).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        id: orderId,
        supplierId,
        authority: 'luma',
        lines: [line],
      }),
      { preventDuplicateSku: false },
    );
    expect(await adapter?.verify(action)).toMatchObject({ outcome: 'passed' });
    expect(
      await adapter?.verify({
        ...action,
        target: { kind: 'purchase_order', id: randomUUID() },
      }),
    ).toMatchObject({ outcome: 'inconclusive' });
  });

  it('rejects malformed, cross-tenant and overly broad intents', async () => {
    const registry = createProcurementEffects({} as ProcurementService);
    expect(
      await registry.resolve(context, intent({ connectionId: randomUUID() })),
    ).toBeNull();
    expect(
      await registry.resolve(
        context,
        intent({
          parameters: { supplierId, reference: 'PO-1', lines: 'bad JSON' },
        }),
      ),
    ).toBeNull();
    expect(
      await registry.resolve(
        context,
        intent({ capability: 'procurement.purchase-order.submit' }),
      ),
    ).toBeNull();
    expect(
      await registry.resolve(
        context,
        intent({ target: { kind: 'supplier', id: orderId } }),
      ),
    ).toBeNull();
  });

  it('checks transition revision and uses one stable command ID for retries', async () => {
    const transitionCommandId = randomUUID();
    const service = {
      detail: vi.fn().mockResolvedValue({
        order: {
          id: orderId,
          tenantId,
          supplierId,
          supplierName: 'Northstar',
          reference: 'PO-1',
          lines: [line],
          origin: {},
          externalReferences: [],
          authority: 'luma',
          status: 'draft',
          revision: 1,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        allowedTransitions: ['open'],
        canManage: true,
        history: [],
      }),
      transition: vi.fn().mockResolvedValue({
        id: orderId,
        tenantId,
        supplierId,
        supplierName: 'Northstar',
        reference: 'PO-1',
        lines: [line],
        origin: {},
        externalReferences: [],
        authority: 'luma',
        status: 'open',
        revision: 2,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:01.000Z',
      }),
    } as unknown as ProcurementService;
    const action = intent({
      capability: 'procurement.purchase-order.transition',
      parameters: {
        status: 'open',
        expectedRevision: 1,
        reason: 'Reviewed',
        commandId: transitionCommandId,
      },
      expectedPostcondition: { status: 'open' },
    });
    const adapter = await createProcurementEffects(service).resolve(
      context,
      action,
    );
    expect(adapter?.minimumRisk).toBe('high');
    expect(await adapter?.checkPreconditions(action)).toBe(true);
    await adapter?.execute(action, 'retry-key');
    await adapter?.execute(action, 'retry-key');
    expect(service.transition).toHaveBeenCalledTimes(2);
    const first = vi.mocked(service.transition).mock.calls[0]?.[2];
    const second = vi.mocked(service.transition).mock.calls[1]?.[2];
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      id: transitionCommandId,
      expectedRevision: 1,
      status: 'open',
      reason: 'Reviewed',
    });
  });
});
