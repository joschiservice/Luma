import { createHash, randomUUID } from 'node:crypto';

import type { AuditEntry } from '@luma/audit';
import type { TenantContext } from '@luma/identity';
import { builtInMembership, makeTenantContext } from '@luma/identity';
import type { ModelGateway } from '@luma/platform';
import { describe, expect, it } from 'vitest';

import {
  type CommitmentDependencies,
  type CommitmentTransaction,
  createSupplierCommitments,
} from '../application/commitments.js';
import type {
  Commitment,
  Communication,
  Extraction,
  FollowUp,
  Submission,
} from '../domain/commitments.js';
import type { PurchaseOrder, Supplier } from '../domain/procurement.js';
import { extractionOutput } from './extraction-schema.js';
import {
  commitmentInputSchema,
  followUpInputSchema,
  messageInputSchema,
  receiptInputSchema,
  reviewInputSchema,
  submissionDecisionSchema,
  submissionInputSchema,
  supplierLinkInputSchema,
} from './validation.js';

function fixture(gateway: ModelGateway | null = null) {
  const tenantId = randomUUID();
  const userId = randomUUID();
  const context = (
    tenant = tenantId,
    user = userId,
    role: 'owner' | 'member' = 'owner',
  ): TenantContext =>
    makeTenantContext(
      { userId: user, sessionId: randomUUID() },
      {
        id: tenant,
        name: 'Workspace',
        slug: 'workspace',
        dataRegion: 'AU',
        status: 'active',
      },
      builtInMembership(
        { id: randomUUID(), organizationId: tenant, userId: user },
        role,
      ),
      randomUUID(),
    );
  const supplier: Supplier = {
    id: randomUUID(),
    tenantId,
    name: 'Supplier',
    externalReferences: [],
    createdAt: '2026-10-01T09:00:00.000Z',
  };
  const order: PurchaseOrder = {
    id: randomUUID(),
    tenantId,
    supplierId: supplier.id,
    supplierName: supplier.name,
    reference: 'PO-1',
    authority: 'luma',
    externalReferences: [],
    origin: {},
    lines: [
      {
        id: randomUUID(),
        sku: 'SKU-1',
        description: 'Item',
        quantity: 100,
        unit: 'each',
      },
    ],
    status: 'open',
    revision: 2,
    createdAt: supplier.createdAt,
    updatedAt: supplier.createdAt,
  };
  const commitments: Commitment[] = [];
  const communications = new Map<string, Communication>();
  const extractions: Extraction[] = [];
  const followUps: FollowUp[] = [];
  const submissions: Submission[] = [];
  const audits: AuditEntry[] = [];
  const commands = new Map<string, { digest: string; result: unknown }>();
  const tx: CommitmentTransaction = {
    order: async (id) => (id === order.id ? order : null),
    orders: async () => [order],
    purchaseOrders: async () => [
      { record: order, position: { rank: 0, keys: null, id: order.id } },
    ],
    countPurchaseOrders: async () => 1,
    supplier: async (id) => (id === supplier.id ? supplier : null),
    updateSupplier: async () => {},
    history: async () => [],
    submissions: async () => submissions,
    submission: async (id) => submissions.find((s) => s.id === id) ?? null,
    insertSubmission: async (value) => {
      submissions.unshift(value);
    },
    saveSubmission: async (value) => {
      const index = submissions.findIndex((s) => s.id === value.id);
      if (index >= 0) submissions[index] = value;
    },
    liveSubmissions: async () => submissions,
    communications: async () => [...communications.values()],
    communication: async (id) =>
      [...communications.values()].find((c) => c.id === id) ?? null,
    communicationByKey: async (key) => communications.get(key) ?? null,
    insertCommunication: async (value, key) => {
      communications.set(key, value);
    },
    purgeCommunication: async () => {},
    extractions: async (ids) =>
      extractions.filter((e) => ids.includes(e.communicationId)),
    insertExtraction: async (value) => {
      extractions.push(value);
    },
    commitments: async () => commitments,
    commitment: async (id) => commitments.find((c) => c.id === id) ?? null,
    insertCommitment: async (value) => {
      commitments.push(value);

      return value;
    },
    reviewCommitment: async () => {},
    latestObservation: async () => null,
    observations: async () => [],
    insertObservation: async () => {},
    followUps: async () => followUps,
    insertFollowUp: async (value) => {
      if (followUps.some((f) => f.key === value.key)) return false;
      followUps.push(value);

      return true;
    },
    command: async (id) => commands.get(id) ?? null,
    saveCommand: async (id, digest, result) => {
      commands.set(id, { digest, result });
    },
    audit: async (value) => {
      audits.push(value);
    },
    skuIdentities: async () => new Map(),
  };
  let tail = Promise.resolve();
  let now = new Date('2026-10-02T12:00:00.000Z');
  let enabled = true;
  const deps: CommitmentDependencies = {
    store: {
      transaction: async (tenant, _write, operation) => {
        if (tenant !== tenantId) throw new Error('Tenant has no records');
        const preceding = tail;
        let release = () => {};
        tail = new Promise<void>((resolve) => {
          release = resolve;
        });
        await preceding;
        try {
          return await operation(tx);
        } finally {
          release();
        }
      },
    },
    purchasing: null,
    admission: null,
    refreshContext: async (ctx) => ctx,
    principal: async () => context(),
    openOrder: async () => {},
    verifiedDrafts: async () => new Set(),
    model: {
      gateway,
      available: !!gateway,
      reason: gateway ? '' : 'Not configured',
      output: extractionOutput,
    },
    trace: (ctx) => ({
      tenantId: ctx.tenantId,
      requestId: ctx.requestId,
      traceId: '00000000000000000000000000000001',
      spanId: '0000000000000001',
    }),
    retentionDays: 365,
    reconciliationAvailable: async () => enabled,
    digest: (value) =>
      createHash('sha256').update(JSON.stringify(value)).digest('hex'),
    id: randomUUID,
    uuid: () => randomUUID(),
    now: () => now,
    parse: {
      link: (input) => supplierLinkInputSchema.parse(input),
      submission: (input) => submissionInputSchema.parse(input),
      decision: (input) => submissionDecisionSchema.parse(input),
      message: (input) => messageInputSchema.parse(input),
      commitment: (input) => commitmentInputSchema.parse(input),
      review: (input) => reviewInputSchema.parse(input),
      followUp: (input) => followUpInputSchema.parse(input),
      receipt: (input) => receiptInputSchema.parse(input),
    },
  };
  const request = () => ({
    id: randomUUID(),
    lineId: order.lines[0]!.id,
    kind: 'received' as const,
    quantity: 40,
    damagedQuantity: 2,
    expectedCommitmentId: null,
    expectedDamagedCommitmentId: null,
    receivedAt: '2026-10-02T10:00:00.000Z',
    condition: 'mixed' as const,
    reason: 'Two broken units',
    evidence: ['Delivery note DN-1', 'photo://broken-units'],
  });

  return {
    service: createSupplierCommitments(deps),
    context,
    order,
    supplier,
    commitments,
    followUps,
    submissions,
    audits,
    request,
    now: (value: string) => {
      now = new Date(value);
    },
    enable: (value: boolean) => {
      enabled = value;
    },
  };
}

describe('receipt reconciliation commands', () => {
  it('stores good and damaged quantities atomically, keeps evidence and returns exact retries', async () => {
    const f = fixture();
    const body = f.request();
    const recorded = await f.service.recordReceipt(
      f.context(),
      f.order.id,
      body,
    );
    expect(recorded.source).toMatchObject({
      kind: 'manual_receipt',
      reason: body.reason,
      evidence: body.evidence,
    });
    expect(f.commitments.map((c) => [c.kind, c.quantity])).toEqual([
      ['received', 40],
      ['damaged', 2],
    ]);
    expect(
      await f.service.recordReceipt(f.context(), f.order.id, body),
    ).toEqual(recorded);
    expect(f.commitments).toHaveLength(2);
    expect(f.audits).toHaveLength(1);
    await expect(
      f.service.recordReceipt(f.context(), f.order.id, {
        ...body,
        quantity: 41,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      f.service.recordReceipt(f.context(), f.order.id, {
        ...body,
        id: randomUUID(),
        quantity: 41,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
  it('refuses receipt owned by a purchasing system and enforces the rollout flag', async () => {
    const f = fixture();
    f.supplier.link = {
      connectionId: randomUUID(),
      externalId: 'supplier',
      scopeKey: '',
      name: null,
      linkedBy: 'buyer',
      linkedAt: f.supplier.createdAt,
    };
    await expect(
      f.service.recordReceipt(f.context(), f.order.id, f.request()),
    ).rejects.toMatchObject({ statusCode: 409 });
    f.supplier.link = null;
    f.enable(false);
    await expect(
      f.service.recordReceipt(f.context(), f.order.id, f.request()),
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(f.commitments).toHaveLength(0);
  });
  it('does not write across tenants and rejects damage above the total receipt', async () => {
    const f = fixture();
    await expect(
      f.service.recordReceipt(f.context(randomUUID()), f.order.id, f.request()),
    ).rejects.toThrow('Tenant has no records');
    await expect(
      f.service.recordReceipt(f.context(), f.order.id, {
        ...f.request(),
        damagedQuantity: 41,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(f.commitments).toHaveLength(0);
  });
  it('serializes conflicting decisions and makes waiting reappear at its deadline', async () => {
    const f = fixture();
    await f.service.recordReceipt(f.context(), f.order.id, f.request());
    const damage = f.commitments.find((c) => c.kind === 'damaged')!;
    const body = {
      id: randomUUID(),
      key: `receipt_difference:${damage.id}`,
      response: 'following_up',
      note: 'Supplier reviewing damage',
      nextCheckAt: '2026-10-04T09:00:00.000Z',
    };
    const results = await Promise.allSettled([
      f.service.respond(f.context(), f.order.id, body),
      f.service.respond(f.context(undefined, randomUUID()), f.order.id, {
        ...body,
        id: randomUUID(),
        response: 'written_off',
        note: 'Discarded',
        nextCheckAt: null,
      }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    expect(f.followUps).toHaveLength(1);
    expect(await f.service.respond(f.context(), f.order.id, body)).toEqual(
      f.followUps[0],
    );
    f.now('2026-10-04T10:00:00.000Z');
    const record = await f.service.order(f.context(), f.order.id);
    expect(record.progress.attention).toContainEqual(
      expect.objectContaining({
        kind: 'receipt_difference',
        key: `${body.key}:${body.nextCheckAt}`,
      }),
    );
  });
});

describe('supplier messages from the inbox', () => {
  /** A model that confirms the ordered quantity, which would count without review. */
  const confirming: ModelGateway = {
    generate: (async (_trace, request) => ({
      output: request.output!.parse({
        relatesToOrder: true,
        facts: [
          {
            kind: 'confirmed_quantity',
            lineId: null,
            quantity: 100,
            date: null,
            text: null,
            quote: 'confirm 100 units',
            confident: true,
          },
        ],
      }),
      toolCalls: [],
      metadata: {
        adapter: 'bedrock' as const,
        model: 'eu.model',
        latencyMs: 1,
        inputTokens: 1,
        outputTokens: 1,
        costUsd: null,
      },
    })) as ModelGateway['generate'],
  };
  const message = () => ({
    id: randomUUID(),
    channel: 'email' as const,
    from: 'sales@supplier.example',
    subject: 'Re: PO-1',
    body: 'We confirm 100 units, on time.',
    receivedAt: '2026-10-02T10:00:00.000Z',
    messageId: `${randomUUID()}@supplier.example`,
  });

  it('holds facts from an unauthenticated sender for review instead of confirming them', async () => {
    const f = fixture(confirming);
    await f.service.recordMessage(f.context(), f.order.id, message(), {
      senderVerified: false,
    });
    expect(f.commitments).toEqual([
      expect.objectContaining({
        kind: 'confirmed_quantity',
        quantity: 100,
        status: 'needs_review',
        reviewReasons: ['sender_unverified'],
      }),
    ]);
  });

  it('confirms matching facts from an authenticated sender or a message a person recorded', async () => {
    const f = fixture(confirming);
    await f.service.recordMessage(f.context(), f.order.id, message(), {
      senderVerified: true,
    });
    await f.service.recordMessage(f.context(), f.order.id, message());
    expect(f.commitments.map((c) => [c.status, c.reviewReasons])).toEqual([
      ['confirmed', []],
      ['confirmed', []],
    ]);
  });

  /** Which message each extracted commitment came from, with its status. */
  const outcomes = (f: ReturnType<typeof fixture>) =>
    f.commitments.map((c) => [
      c.source.kind === 'communication' ? c.source.communicationId : null,
      c.status,
    ]);

  it('lets a genuine message through after a forged one claimed its Message-ID', async () => {
    const f = fixture(confirming);
    const genuine = message();
    const forged = {
      ...genuine,
      id: randomUUID(),
      body: 'We confirm 100 units, delivery moved to December.',
    };
    expect(
      await f.service.recordMessage(f.context(), f.order.id, forged, {
        senderVerified: false,
      }),
    ).toEqual({ communicationId: forged.id, duplicate: false });
    expect(
      await f.service.recordMessage(f.context(), f.order.id, genuine, {
        senderVerified: true,
      }),
    ).toEqual({ communicationId: genuine.id, duplicate: false });
    expect(outcomes(f)).toEqual([
      [forged.id, 'needs_review'],
      [genuine.id, 'confirmed'],
    ]);
  });

  it('keeps a genuine message when a forged one with its Message-ID arrives later', async () => {
    const f = fixture(confirming);
    const genuine = message();
    await f.service.recordMessage(f.context(), f.order.id, genuine, {
      senderVerified: true,
    });
    const forged = {
      ...genuine,
      id: randomUUID(),
      body: 'We confirm 100 units, delivery moved to December.',
    };
    expect(
      await f.service.recordMessage(f.context(), f.order.id, forged, {
        senderVerified: false,
      }),
    ).toEqual({ communicationId: forged.id, duplicate: false });
    // An unverified copy with the same text adds nothing.
    expect(
      await f.service.recordMessage(
        f.context(),
        f.order.id,
        { ...genuine, id: randomUUID() },
        { senderVerified: false },
      ),
    ).toEqual({ communicationId: genuine.id, duplicate: true });
    expect(outcomes(f)).toEqual([
      [genuine.id, 'confirmed'],
      [forged.id, 'needs_review'],
    ]);
  });
});
