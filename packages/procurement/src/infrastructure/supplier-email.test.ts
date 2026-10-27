import { createHash, randomUUID } from 'node:crypto';

import { builtInMembership, makeTenantContext } from '@luma/identity';
import { describe, expect, it, vi } from 'vitest';

import {
  createSupplierEmail,
  type SupplierEmailDraft,
  type SupplierMailbox,
  type SupplierMailWork,
} from '../application/supplier-email.js';
import type { Commitment, Submission } from '../domain/commitments.js';
import { orderProgress } from '../domain/commitments.js';
import type { PurchaseOrder, Supplier } from '../domain/procurement.js';
import {
  supplierEmailInputSchema,
  supplierFollowUpInputSchema,
} from './supplier-email-validation.js';

function fixture() {
  const tenantId = randomUUID();
  const userId = randomUUID();
  const context = (tenant = tenantId, role: 'owner' | 'member' = 'owner') =>
    makeTenantContext(
      { userId, sessionId: randomUUID() },
      {
        id: tenant,
        name: 'Shop',
        slug: 'shop',
        dataRegion: 'AU',
        status: 'active',
      },
      builtInMembership(
        { id: randomUUID(), organizationId: tenant, userId },
        role,
      ),
      randomUUID(),
    );
  const supplier: Supplier = {
    id: randomUUID(),
    tenantId,
    name: 'Müller GmbH',
    email: 'sales@supplier.example',
    language: 'de',
    externalReferences: [],
    createdAt: '2026-10-01T00:00:00.000Z',
  };
  const order: PurchaseOrder = {
    id: randomUUID(),
    tenantId,
    supplierId: supplier.id,
    supplierName: supplier.name,
    reference: 'PO-1001',
    authority: 'luma',
    externalReferences: [],
    origin: {},
    lines: [
      {
        id: randomUUID(),
        sku: 'SKU-1',
        description: 'Item',
        quantity: 40,
        unit: 'each',
        supplierArticleNumber: 'ART-1',
        unitPrice: { amount: '3.50', currency: 'EUR' },
      },
    ],
    status: 'draft',
    revision: 1,
    createdAt: supplier.createdAt,
    updatedAt: supplier.createdAt,
  };
  const connectionId = randomUUID();
  let active = true;
  let available = true;
  let submission: Submission | null = null;
  const commitments: Commitment[] = [];
  const threadId = randomUUID();
  const work: { outbound: SupplierEmailDraft; work: SupplierMailWork }[] = [];
  const compose = vi.fn<SupplierMailbox['compose']>(async (_ctx, request) => {
    const outbound: SupplierEmailDraft = {
      id: request.id,
      threadId: request.threadId ?? randomUUID(),
      connectionId,
      subject: request.subject,
      text: request.text,
      state: 'draft',
      stateReason: null,
      sentMessageId: null,
      delivery: { report: null, resolution: null },
      canResolveDelivery: false,
      revision: 1,
    };
    work.push({ outbound, work: request.procurement });

    return outbound;
  });
  const recordEmailSubmission = vi.fn<
    Parameters<
      typeof createSupplierEmail
    >[0]['commitments']['recordEmailSubmission']
  >(async () => {});
  const respond = vi.fn<
    Parameters<typeof createSupplierEmail>[0]['commitments']['respond']
  >(async () => {});
  const service = createSupplierEmail({
    commitments: {
      order: async (ctx, id) => {
        if (ctx.tenantId !== tenantId || id !== order.id)
          throw new Error('not found');

        return {
          order,
          supplier,
          submission,
          progress: orderProgress({
            order,
            submission,
            commitments,
            followUps: [],
            terms: { confirmationHours: 48 },
            draftVerified: false,
            supplierLinked: false,
            now: new Date('2026-10-13T00:00:00Z'),
            timeZone: 'UTC',
          }),
        };
      },
      recordEmailSubmission,
      respond,
    },
    inbox: {
      mailboxes: async () => ({
        items: [
          {
            connectionId,
            label: 'Operations',
            address: 'ops@shop.example',
            connectionStatus: active ? 'active' : 'revoked',
            canSend: active,
          },
        ],
      }),
      threads: async () => [
        { id: threadId, connectionId, address: supplier.email ?? null },
      ],
      work: async () => work,
      compose,
      attachment: async () => ({
        filename: 'order.pdf',
        mimeType: 'application/pdf',
        base64: 'UEZERg==',
      }),
    },
    refreshContext: async (c) => c,
    available: async () => available,
    pdf: async () => new Uint8Array([37, 80, 68, 70]),
    parseSubmission: (input) => supplierEmailInputSchema.parse(input),
    parseFollowUp: (input) => supplierFollowUpInputSchema.parse(input),
    now: () => new Date('2026-10-13T00:00:00Z'),
    digest: (value) =>
      createHash('sha256').update(JSON.stringify(value)).digest('hex'),
  });
  const request = {
    id: randomUUID(),
    connectionId,
    requestedDeliveryDate: '2026-10-20',
    company: { name: 'Shop GmbH', address: 'Berlin', registration: null },
  };

  return {
    service,
    context,
    order,
    supplier,
    compose,
    recordEmailSubmission,
    respond,
    request,
    work,
    threadId,
    commitments,
    submitted: () => {
      order.status = 'open';
      submission = {
        id: randomUUID(),
        tenantId,
        purchaseOrderId: order.id,
        connectionId,
        supplier: { externalId: supplier.id, scopeKey: '' },
        requestedDeliveryDate: '2026-10-10',
        lines: order.lines.map((l) => ({
          lineId: l.id,
          sku: { externalId: l.sku, scopeKey: '' },
          quantity: l.quantity,
          unit: l.unit,
        })),
        actionId: randomUUID(),
        decisionId: null,
        requestedBy: userId,
        requestedAt: '2026-10-01T00:00:00.000Z',
        expiresAt: '2026-10-02T00:00:00.000Z',
        state: 'submitted',
        externalOrder: null,
        submittedAt: '2026-10-01T00:00:00.000Z',
        decidedBy: null,
        decidedAt: null,
        failure: null,
        updatedAt: '2026-10-01T00:00:00.000Z',
        channel: 'email',
      };

      return orderProgress({
        order,
        submission,
        commitments,
        followUps: [],
        terms: { confirmationHours: 48 },
        draftVerified: false,
        supplierLinked: false,
        now: new Date('2026-10-13T00:00:00Z'),
        timeZone: 'UTC',
      });
    },
    active: (value: boolean) => {
      active = value;
    },
    available: (value: boolean) => {
      available = value;
    },
  };
}

describe('supplier email drafts', () => {
  it('snapshots the PDF and known supplier language without submitting, and returns exact retries', async () => {
    const f = fixture();
    const draft = await f.service.submission(
      f.context(),
      f.order.id,
      f.request,
    );
    expect(draft.subject).toBe('Bestellung PO-1001');
    expect(f.compose.mock.calls[0]?.[1]).toMatchObject({
      to: [{ address: f.supplier.email, name: f.supplier.name }],
      attachments: [{ mimeType: 'application/pdf', base64: 'JVBERg==' }],
      procurement: { kind: 'submission', orderRevision: 1 },
    });
    expect(f.recordEmailSubmission).not.toHaveBeenCalled();
    f.order.revision = 2;
    expect(
      await f.service.submission(f.context(), f.order.id, f.request),
    ).toEqual(draft);
    expect(f.compose).toHaveBeenCalledTimes(1);
    await expect(
      f.service.submission(f.context(), f.order.id, {
        ...f.request,
        requestedDeliveryDate: '2026-11-01',
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
  it('rejects a second active order email, missing contact, disabled rollout and access loss', async () => {
    const f = fixture();
    await f.service.submission(f.context(), f.order.id, f.request);
    await expect(
      f.service.submission(f.context(), f.order.id, {
        ...f.request,
        id: randomUUID(),
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    f.active(false);
    await expect(
      f.service.submission(f.context(), f.order.id, f.request),
    ).rejects.toMatchObject({ statusCode: 409 });
    f.active(true);
    f.available(false);
    await expect(
      f.service.submission(f.context(), f.order.id, f.request),
    ).rejects.toMatchObject({ statusCode: 503 });
    await expect(
      f.service.submission(
        f.context(undefined, 'member'),
        f.order.id,
        f.request,
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      f.service.status(f.context(randomUUID()), f.order.id),
    ).rejects.toThrow('not found');
  });
  it('hands off verified, uncertain and bounced sends as separate submission evidence, never confirmations', async () => {
    const f = fixture();
    await f.service.submission(f.context(), f.order.id, f.request);
    const work = f.work[0]!.work;
    const outbound = {
      id: f.request.id,
      threadId: randomUUID(),
      connectionId: f.request.connectionId,
      state: 'uncertain',
      document: { procurement: work, sentMessageId: null, stateReason: null },
    };
    await f.service.settled(f.context(), outbound);
    expect(f.recordEmailSubmission.mock.calls[0]?.[1]).toMatchObject({
      state: 'uncertain',
    });
    await f.service.settled(f.context(), {
      ...outbound,
      state: 'sent',
      document: { ...outbound.document, sentMessageId: randomUUID() },
    });
    expect(f.recordEmailSubmission.mock.calls[1]?.[1]).toMatchObject({
      state: 'submitted',
    });
    await f.service.settled(f.context(), {
      ...outbound,
      state: 'failed',
      document: { ...outbound.document, stateReason: '5.1.1' },
    });
    expect(f.recordEmailSubmission.mock.calls[2]?.[1]).toMatchObject({
      state: 'failed',
      reason: '5.1.1',
    });
    // A person's delivery decision is passed on so procurement records who decided, once.
    const decision = {
      id: randomUUID(),
      source: 'person' as const,
      by: randomUUID(),
      at: new Date().toISOString(),
    };
    await f.service.settled(f.context(), {
      ...outbound,
      state: 'failed',
      document: {
        ...outbound.document,
        stateReason: 'Not delivered',
        deliveryResolution: decision,
      },
    });
    expect(f.recordEmailSubmission.mock.calls[3]?.[1]).toMatchObject({
      state: 'failed',
      decision,
    });
    expect(f.respond).not.toHaveBeenCalled();
  });
  it('withholds approved work after the order changes or the release turns off', async () => {
    const f = fixture();
    await f.service.submission(f.context(), f.order.id, f.request);
    const outbound = { document: { procurement: f.work[0]!.work } };
    expect(await f.service.eligible(f.context(), outbound)).toBe(true);
    f.order.status = 'cancelled';
    expect(await f.service.eligible(f.context(), outbound)).toBe(false);
    f.order.status = 'draft';
    f.available(false);
    expect(await f.service.eligible(f.context(), outbound)).toBe(false);
  });
});

describe('supplier follow-up drafts', () => {
  it('keeps supplier promises distinct from requested dates when following up an overdue delivery', async () => {
    const f = fixture();
    f.submitted();
    const base = {
      tenantId: f.order.tenantId,
      purchaseOrderId: f.order.id,
      lineId: f.order.lines[0]!.id,
      text: null,
      source: {
        kind: 'purchasing_system' as const,
        connectionId: f.request.connectionId,
        observationId: randomUUID(),
        observedAt: '2026-10-01T00:00:00Z',
        externalOrderId: '1',
      },
      status: 'confirmed' as const,
      reviewReasons: [],
      supersedes: null,
      recordedAt: '2026-10-01T00:00:00Z',
      recordedBy: { kind: 'luma' as const, id: 'luma' },
      review: null,
    };
    f.commitments.push(
      {
        ...base,
        id: randomUUID(),
        kind: 'confirmed_quantity',
        quantity: 35,
        date: null,
      },
      {
        ...base,
        id: randomUUID(),
        kind: 'promised_date',
        quantity: null,
        date: '2026-10-09',
      },
    );
    const progress = f.submitted();
    const attention = progress.attention.find(
      (item) => item.kind === 'delivery_overdue',
    )!;
    expect(attention).toBeTruthy();
    const draft = await f.service.followUp(f.context(), f.order.id, {
      id: randomUUID(),
      connectionId: f.request.connectionId,
      attentionKey: attention.key,
      nextCheckAt: '2026-10-16T09:00:00Z',
      reason: 'Check the overdue supplier promise',
    });
    expect(draft.text).toContain(
      '35 Stück offen; bestätigt: 35; zugesagt: 2026-10-09; angefragt: 2026-10-10',
    );
    expect(f.respond).not.toHaveBeenCalled();
    await f.service.settled(f.context(), {
      id: draft.id,
      threadId: draft.threadId,
      connectionId: draft.connectionId,
      state: 'sent',
      document: { procurement: f.work[0]!.work, sentMessageId: 'message' },
    });
    expect(f.respond.mock.calls[0]?.[2]).toMatchObject({
      key: attention.key,
      response: 'following_up',
      nextCheckAt: '2026-10-16T09:00:00Z',
    });
  });
  it('drafts from the overdue order in the supplier language and records its deadline only after a verified send', async () => {
    const f = fixture();
    const progress = f.submitted();
    const attention = progress.attention.find(
      (item) => item.kind === 'confirmation_overdue',
    );
    expect(attention).toBeTruthy();
    const body = {
      id: randomUUID(),
      connectionId: f.request.connectionId,
      threadId: f.threadId,
      attentionKey: attention!.key,
      nextCheckAt: '2026-10-16T09:00:00.000Z',
      reason: 'Ask supplier for an update',
    };
    const draft = await f.service.followUp(f.context(), f.order.id, body);
    expect(draft.text).toContain('40 Stück offen');
    expect(draft.text).toContain(
      'zugesagt: kein Termin; angefragt: 2026-10-10',
    );
    expect(f.compose.mock.calls[0]?.[1].threadId).toBe(f.threadId);
    expect(f.respond).not.toHaveBeenCalled();
    await f.service.settled(f.context(), {
      id: draft.id,
      threadId: draft.threadId,
      connectionId: draft.connectionId,
      state: 'uncertain',
      document: { procurement: f.work[0]!.work },
    });
    expect(f.respond).not.toHaveBeenCalled();
    await f.service.settled(f.context(), {
      id: draft.id,
      threadId: draft.threadId,
      connectionId: draft.connectionId,
      state: 'sent',
      document: { procurement: f.work[0]!.work, sentMessageId: 'message' },
    });
    expect(f.respond).toHaveBeenCalledWith(
      expect.anything(),
      f.order.id,
      expect.objectContaining({
        key: attention!.key,
        response: 'following_up',
        nextCheckAt: body.nextCheckAt,
      }),
    );
    expect(await f.service.followUp(f.context(), f.order.id, body)).toEqual(
      draft,
    );
  });
  it('refuses stale attention, another order thread and expired check dates before composing anything', async () => {
    const f = fixture();
    const attention = f
      .submitted()
      .attention.find((item) => item.kind === 'confirmation_overdue')!;
    const body = {
      id: randomUUID(),
      connectionId: f.request.connectionId,
      attentionKey: attention.key,
      nextCheckAt: '2026-10-16T09:00:00.000Z',
      reason: 'Need confirmation',
    };
    await expect(
      f.service.followUp(f.context(), f.order.id, {
        ...body,
        attentionKey: 'old-deadline',
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      f.service.followUp(f.context(), f.order.id, {
        ...body,
        threadId: randomUUID(),
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      f.service.followUp(f.context(), f.order.id, {
        ...body,
        nextCheckAt: '2026-10-12T00:00:00Z',
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(f.compose).not.toHaveBeenCalled();
  });
});
