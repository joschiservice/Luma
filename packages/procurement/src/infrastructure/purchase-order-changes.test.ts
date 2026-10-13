import { randomUUID } from 'node:crypto';

import type { TenantContext } from '@luma/identity';
import {
  builtInMembership,
  makeTenantContext,
  PermissionSet,
} from '@luma/identity';
import type { PolicyDecision } from '@luma/policies';
import { expect, it } from 'vitest';

import type {
  PurchasingOrder,
  PurchasingSystem,
} from '../application/commitments.js';
import {
  createPurchaseOrderChangeService,
  type PurchaseOrderChangeAdmission,
  type PurchaseOrderChangeStore,
} from '../application/purchase-order-changes.js';
import {
  defaultSupplierTerms,
  orderProgress,
  type Submission,
} from '../domain/commitments.js';
import type { PurchaseOrder, Supplier } from '../domain/procurement.js';
import type {
  PurchaseOrderChange,
  PurchaseOrderRevision,
} from '../domain/purchase-order-changes.js';
import { purchaseOrderChangeInputSchema } from './purchase-order-changes-validation.js';

const tenantId = randomUUID(),
  orderId = randomUUID(),
  lineId = randomUUID(),
  supplierId = randomUUID(),
  connectionId = randomUUID();
const now = '2026-10-13T12:00:00.000Z';

function actor(userId: string) {
  return makeTenantContext(
    { userId, sessionId: randomUUID() },
    {
      id: tenantId,
      name: 'Shop',
      slug: 'shop',
      dataRegion: 'EU',
      status: 'active',
    },
    builtInMembership(
      { id: randomUUID(), organizationId: tenantId, userId },
      'owner',
    ),
    randomUUID(),
  );
}

const buyer = actor('buyer'),
  approver = actor('approver');

function fixture() {
  let order: PurchaseOrder = {
    id: orderId,
    tenantId,
    supplierId,
    supplierName: 'Supplier',
    reference: 'PO-1',
    authority: 'luma',
    status: 'open',
    revision: 2,
    externalReferences: [],
    origin: {},
    createdAt: now,
    updatedAt: now,
    lines: [
      {
        id: lineId,
        sku: 'SKU-1',
        description: 'Item',
        quantity: 12,
        unit: 'each',
      },
    ],
  };
  const supplier: Supplier = {
    id: supplierId,
    tenantId,
    name: 'Supplier',
    externalReferences: [],
    createdAt: now,
    link: {
      connectionId,
      externalId: '10',
      scopeKey: 'global',
      name: null,
      linkedBy: 'buyer',
      linkedAt: now,
    },
  };
  const submission: Submission = {
    id: randomUUID(),
    tenantId,
    purchaseOrderId: orderId,
    connectionId,
    supplier: { externalId: '10', scopeKey: 'global' },
    requestedDeliveryDate: '2026-10-20',
    lines: [
      {
        lineId,
        sku: { externalId: '1', scopeKey: 'global' },
        quantity: 12,
        unit: 'each',
      },
    ],
    actionId: randomUUID(),
    decisionId: null,
    requestedBy: 'buyer',
    requestedAt: now,
    expiresAt: '2026-10-14T12:00:00.000Z',
    state: 'submitted',
    externalOrder: { externalId: '50', orderNumber: 'PO-50' },
    submittedAt: now,
    decidedBy: 'approver',
    decidedAt: now,
    failure: null,
    updatedAt: now,
  };
  const source: PurchasingOrder = {
    observationId: randomUUID(),
    observedAt: now,
    externalId: '50',
    scopeKey: 'global',
    data: {
      supplier: submission.supplier,
      orderNumber: 'PO-50',
      lumaOrderId: orderId,
      status: 'released',
      requestedDeliveryDate: '2026-10-20',
      confirmed: false,
      createdAt: now,
      lines: [
        {
          id: { externalId: '500', scopeKey: '50' },
          sku: { externalId: '1', scopeKey: 'global' },
          itemNumber: 'SKU-1',
          quantity: { amount: '12', unit: 'each' },
          deliveredQuantity: '0',
          confirmedQuantity: null,
          confirmedDeliveryDate: null,
          confirmed: false,
          requestedDeliveryDate: '2026-10-20',
        },
      ],
    },
  };
  const changes = new Map<string, PurchaseOrderChange>(),
    revisions: PurchaseOrderRevision[] = [];
  const store: PurchaseOrderChangeStore = {
    transaction: async (tenant, _write, fn) =>
      fn({
        order: async (id) =>
          tenant === tenantId && id === orderId ? structuredClone(order) : null,
        changes: async (id, states) =>
          tenant === tenantId
            ? [...changes.values()].filter(
                (v) =>
                  (!id || v.purchaseOrderId === id) &&
                  (!states || states.includes(v.state)),
              )
            : [],
        change: async (id) =>
          tenant === tenantId ? structuredClone(changes.get(id) ?? null) : null,
        insert: async (v) => {
          changes.set(v.id, structuredClone(v));
        },
        save: async (v) => {
          changes.set(v.id, structuredClone(v));
        },
        revisions: async () => revisions,
        supplierLink: async () => supplier.link!,
        skuIdentity: async (_connection, sku) =>
          sku === 'SKU-1' ? { externalId: '1', scopeKey: 'global' } : null,
        apply: async (change, observedAt, observationRefs) => {
          revisions.push({
            order: structuredClone(order),
            changeId: change.id,
            reason: change.request.reason,
            recordedBy: change.requestedBy,
            recordedAt: observedAt,
            observationRefs,
          });
          order = structuredClone(change.proposed);
        },
      }),
  };
  let reads = 0,
    writes = 0,
    reconciles = 0,
    prepares = 0,
    failPrepare = false,
    enabled = true,
    fresh: TenantContext | null = null,
    readOk = true;
  const decision: PolicyDecision & {
    approval?: { outcome: 'approved' | 'rejected'; approverId: string };
    requireIndependentApproval: boolean;
  } = {
    id: randomUUID(),
    tenantId,
    correlationId: randomUUID(),
    proposalId: randomUUID(),
    actionHash: 'bound',
    actorId: 'buyer',
    capability: 'purchase-orders.revise',
    policyVersion: 'v0.1',
    outcome: 'approval_required',
    reason: 'approval_required',
    evaluatedAt: now,
    validUntil: '2026-10-14T12:00:00.000Z',
    requireIndependentApproval: true,
  };
  const admission: PurchaseOrderChangeAdmission = {
    prepare: async () => {
      prepares++;
      if (failPrepare) throw Error('Stopped after request persistence');

      return decision;
    },
    decision: async () => decision,
    respond: async (c, _id, outcome) => {
      if (c.actor.id === 'buyer') throw Error('Independent approval required');
      decision.approval = { outcome, approverId: c.actor.id };
    },
    execute: async () => {
      writes++;

      return { state: 'uncertain' };
    },
    reconcile: async () => {
      reconciles++;

      return { state: 'uncertain' };
    },
  };
  const purchasing: PurchasingSystem = {
    connections: async () => [],
    suppliers: async () => ({
      ok: true,
      value: { items: [], nextCursor: null },
    }),
    orders: async () => {
      reads++;

      return readOk
        ? { ok: true, value: [structuredClone(source)] }
        : { ok: false, reason: 'incomplete' };
    },
  };
  const create = () =>
    createPurchaseOrderChangeService({
      store,
      commitments: {
        order: async () => ({
          order: structuredClone(order),
          supplier,
          submission,
          progress: orderProgress({
            order,
            submission,
            commitments: [],
            followUps: [],
            terms: defaultSupplierTerms,
            draftVerified: false,
            supplierLinked: true,
            now: new Date(now),
          }),
        }),
        refresh: async () => {},
      },
      purchasing,
      admission,
      refreshContext: async (c) => fresh ?? c,
      principal: async () => buyer,
      released: async () => enabled,
      canRevise: async () => true,
      parse: (input) => purchaseOrderChangeInputSchema.parse(input),
      digest: JSON.stringify,
      uuid: () => randomUUID(),
      now: () => new Date(now),
    });
  const request = {
    id: randomUUID(),
    expectedRevision: 2,
    reason: 'Supplier confirmed six units; stop the remainder',
    operation: { kind: 'update_line' as const, lineId, quantity: 6 },
  };

  return {
    service: create(),
    create,
    request,
    source,
    changes,
    revisions,
    admission,
    setPrepareFailure: (value: boolean) => {
      failPrepare = value;
    },
    setEnabled: (value: boolean) => {
      enabled = value;
    },
    setFresh: (value: TenantContext) => {
      fresh = value;
    },
    setReadOk: (value: boolean) => {
      readOk = value;
    },
    counts: () => ({ reads, writes, reconciles, prepares }),
    order: () => order,
  };
}

it('freezes source intent, refuses request-ID reuse and shows current independent-approval authority without provider reads', async () => {
  const f = fixture();
  const change = await f.service.propose(buyer, orderId, f.request);
  expect(change.state).toBe('approval_required');
  expect(change.proposed.lines[0]!.quantity).toBe(6);
  expect((await f.service.propose(buyer, orderId, f.request)).id).toBe(
    change.id,
  );
  await expect(
    f.service.propose(buyer, orderId, { ...f.request, reason: 'Different' }),
  ).rejects.toMatchObject({ statusCode: 409 });
  const reads = f.counts().reads;
  expect((await f.service.pending(buyer))[0]!.canApprove).toBe(false);
  expect((await f.service.pending(approver))[0]!.canApprove).toBe(true);
  expect((await f.service.list(approver, orderId)).changes[0]!.canApprove).toBe(
    true,
  );
  expect(f.counts().reads).toBe(reads);
});

it('restores a stopped preparation and never repeats an uncertain provider write across service restarts', async () => {
  const f = fixture();
  f.setPrepareFailure(true);
  await expect(f.service.propose(buyer, orderId, f.request)).rejects.toThrow(
    'Stopped',
  );
  f.setPrepareFailure(false);
  const restarted = f.create();
  expect((await restarted.send(buyer, f.request.id)).state).toBe(
    'approval_required',
  );
  await expect(
    restarted.decide(buyer, f.request.id, 'approved'),
  ).rejects.toThrow('Independent');
  expect(
    (await restarted.decide(approver, f.request.id, 'approved')).state,
  ).toBe('uncertain');
  await f.create().send(buyer, f.request.id);
  await f.create().check(buyer, f.request.id);
  expect(f.counts().writes).toBe(1);
  expect(f.counts().reconciles).toBe(1);
  expect(f.order().revision).toBe(2);
});

it('commits an immutable previous revision only after a fresh matching independent read', async () => {
  const f = fixture();
  await f.service.propose(buyer, orderId, f.request);
  await f.service.decide(approver, f.request.id, 'approved');
  expect((await f.service.verify(buyer, f.request.id)).outcome).toBe(
    'inconclusive',
  );
  f.source.data.lines[0]!.quantity.amount = '6';
  f.source.observedAt = '2026-10-12T12:00:00.000Z';
  expect((await f.service.verify(buyer, f.request.id)).outcome).toBe(
    'inconclusive',
  );
  f.source.observedAt = now;
  f.source.data.lines[0]!.sku!.externalId = 'OTHER';
  expect((await f.service.verify(buyer, f.request.id)).outcome).toBe(
    'inconclusive',
  );
  f.source.data.lines[0]!.sku!.externalId = '1';
  expect((await f.service.verify(buyer, f.request.id)).outcome).toBe('passed');
  expect(f.order().revision).toBe(3);
  expect(f.revisions[0]!.order.lines[0]!.quantity).toBe(12);
  expect(f.order().lines[0]!.quantity).toBe(6);
  await f.service.verify(buyer, f.request.id);
  expect(f.revisions).toHaveLength(1);
  expect(f.counts().writes).toBe(1);
});

it('refuses incomplete reads, externally changed quantities, received lines, final-line removal and cancellation', async () => {
  const f = fixture();
  f.setReadOk(false);
  await expect(
    f.service.propose(buyer, orderId, f.request),
  ).rejects.toMatchObject({ statusCode: 409 });
  f.setReadOk(true);
  f.source.data.lines[0]!.quantity.amount = '10';
  await expect(f.service.propose(buyer, orderId, f.request)).rejects.toThrow(
    'quantities differ',
  );
  f.source.data.lines[0]!.quantity.amount = '12';
  f.source.data.lines[0]!.deliveredQuantity = '1';
  await expect(f.service.propose(buyer, orderId, f.request)).rejects.toThrow(
    'Received lines',
  );
  f.source.data.lines[0]!.deliveredQuantity = '0';
  await expect(
    f.service.propose(buyer, orderId, {
      ...f.request,
      operation: { kind: 'remove_line', lineId },
    }),
  ).rejects.toThrow('at least one line');
  await expect(
    f.service.propose(buyer, orderId, {
      ...f.request,
      operation: { kind: 'cancel' },
    }),
  ).rejects.toThrow('does not expose');
  expect(f.counts().writes).toBe(0);
});

it('refreshes authority and release gates and isolates stored requests by tenant', async () => {
  const f = fixture();
  await f.service.propose(buyer, orderId, f.request);
  const foreignTenant = randomUUID();
  const foreign = makeTenantContext(
    { userId: 'buyer', sessionId: randomUUID() },
    {
      id: foreignTenant,
      name: 'Other',
      slug: 'other',
      dataRegion: 'EU',
      status: 'active',
    },
    builtInMembership(
      { id: randomUUID(), organizationId: foreignTenant, userId: 'buyer' },
      'owner',
    ),
    randomUUID(),
  );
  await expect(f.service.send(foreign, f.request.id)).rejects.toMatchObject({
    statusCode: 404,
  });
  f.setEnabled(false);
  expect(await f.service.pending(buyer)).toEqual([]);
  await expect(f.service.send(buyer, f.request.id)).rejects.toMatchObject({
    statusCode: 403,
  });
  f.setEnabled(true);
  f.setFresh({
    ...buyer,
    permissions: new PermissionSet(['procurement.read']),
  });
  await expect(
    f.service.propose(buyer, orderId, { ...f.request, id: randomUUID() }),
  ).rejects.toMatchObject({ statusCode: 403 });
});

it('flags a supplier confirmation found by the fresh source read even before local commitment sync', async () => {
  const f = fixture();
  f.source.data.lines[0]!.confirmedQuantity = '12';
  f.source.data.lines[0]!.confirmed = true;
  expect(
    (await f.service.propose(buyer, orderId, f.request)).affectsCommitments,
  ).toBe(true);
});
