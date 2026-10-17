import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

import { createAuditLog } from '@luma/audit/composition';
import type { EffectAdapter, EffectRegistry } from '@luma/connections';
import type { MessageSendBinding } from '@luma/connections/composition';
import type { TenantContext } from '@luma/identity';
import {
  builtInMembership,
  makeTenantContext,
} from '@luma/identity/composition';
import type {
  MailboxConnection,
  MessageData,
  MessageReader,
  RecordStates,
} from '@luma/messaging';
import { createMessaging } from '@luma/messaging/composition';
import { createTenantDatabase } from '@luma/platform/composition';
import { createProcurement } from '@luma/procurement/composition';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createRecordDirectory } from './composition/messaging.js';
import {
  createReplyAdmission,
  createReplyEffects,
} from './composition/messaging-replies.js';
import { createSafetyServices } from './composition/services.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('replies on PostgreSQL', () => {
  const name = `replies_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: databaseUrl });
  let owner: Pool;
  let runtime: Pool;
  const tenant = randomUUID();
  const otherTenant = randomUUID();
  const connectionId = randomUUID();
  const aliceId = randomUUID();
  const bobId = randomUUID();
  const memberId = randomUUID();
  const outsiderId = randomUUID();
  const orderId = randomUUID();
  const supplierEvents: { id: string; state: string }[] = [];
  let rebuildMessaging: () => ReturnType<typeof createMessaging>;

  const context = (
    userId: string,
    role: 'admin' | 'member',
    organization = tenant,
  ): TenantContext =>
    makeTenantContext(
      { userId, sessionId: `session-${userId}` },
      {
        id: organization,
        name: 'Shop',
        slug: `shop-${organization}`,
        dataRegion: 'AU',
        status: 'active',
      },
      builtInMembership(
        { id: `membership-${userId}`, organizationId: organization, userId },
        role,
      ),
      randomUUID(),
    );
  const alice = () => context(aliceId, 'admin');
  const bob = () => context(bobId, 'admin');

  /** The provider mailbox: stored messages per thread, and every send that reached it. */
  const mailbox: { providerMessageId: string; data: MessageData }[] = [];
  const sends: string[] = [];
  let loseResponse = false;
  let hideThread = false;
  let partialThread = false;
  let endlessThread = false;
  let corruptAttachment = false;
  let staleObservation = false;
  const ops = { address: 'ops@shop.example', name: null };
  const anna = { address: 'anna@acme.example', name: 'Anna' };
  mailbox.push({
    providerMessageId: 'm1',
    data: {
      thread: { externalId: 't1', scopeKey: '' },
      rfcMessageId: 'm1@acme.example',
      inReplyTo: null,
      references: [],
      direction: 'inbound',
      from: anna,
      to: [ops],
      cc: [],
      replyTo: [],
      subject: 'Order 1001',
      text: 'Hello, when will order 1001 arrive? Thanks',
      truncated: false,
      sentAt: new Date(Date.now() - 3_600_000).toISOString(),
      receivedAt: new Date(Date.now() - 3_600_000).toISOString(),
      labels: ['INBOX'],
      attachments: [],
    },
  });
  const reader: MessageReader = {
    async messages(_context, _connection, input) {
      return {
        ok: true,
        items: mailbox.filter((m) => m.data.receivedAt >= input.receivedSince),
        nextCursor: null,
      };
    },
    async thread(_context, _connection, input) {
      return {
        ok: true,
        complete: !partialThread,
        items: mailbox
          .filter(
            (m) =>
              !hideThread &&
              (m.data.thread.externalId === input.thread.externalId ||
                (input.thread.externalId.startsWith('outbound:') &&
                  m.data.rfcMessageId ===
                    `luma.${input.thread.externalId.slice(9)}@shop.example`)),
          )
          .map((item) => ({
            ...item,
            observationId: `provider:${item.providerMessageId}`,
            observedAt: staleObservation
              ? '2000-01-01T00:00:00.000Z'
              : new Date().toISOString(),
          })),
        nextCursor: endlessThread ? 'more' : null,
      };
    },
  };
  /**
   * Sends like the Gmail adapter: the Message-ID derives from the outbound ID and a message with
   * that ID is never sent twice. `loseResponse` drops the response after the send happened.
   */
  const sender = {
    sendEffects: (binding: MessageSendBinding): EffectRegistry => ({
      async resolve(ctx, intent) {
        const input = await binding.map(ctx, intent);
        if (!input) return null;
        const adapter: EffectAdapter = {
          dispatchIdentity: 'fake-mailbox/1',
          capability: 'messages.send',
          version: '0',
          minimumRisk: 'low',
          permission: 'gmail:messages.send',
          mechanism: 'api',
          executor: { kind: 'connector', id: 'fake-mailbox' },
          checkPreconditions: (action) =>
            binding.checkPreconditions(ctx, action),
          async execute(action, idempotencyKey) {
            const messageId = `luma.${input.outboundId}@shop.example`;
            if (!mailbox.some((m) => m.data.rfcMessageId === messageId)) {
              sends.push(input.outboundId);
              const at = new Date().toISOString();
              mailbox.push({
                providerMessageId: `sent-${sends.length}`,
                data: {
                  thread: input.thread ?? {
                    externalId: `new-${input.outboundId}`,
                    scopeKey: '',
                  },
                  rfcMessageId: messageId,
                  inReplyTo: input.inReplyTo,
                  references: input.references,
                  direction: 'outbound',
                  providerSent: true,
                  from: ops,
                  to: input.to,
                  cc: input.cc,
                  replyTo: [],
                  subject: input.subject,
                  text: input.text,
                  truncated: false,
                  sentAt: at,
                  receivedAt: at,
                  labels: ['SENT'],
                  attachments: (input.attachments ?? []).map((file, index) => ({
                    attachment: {
                      externalId: String(index),
                      scopeKey: `sent-${sends.length}`,
                    },
                    filename: file.filename,
                    mimeType: file.mimeType,
                    size: Buffer.from(file.base64, 'base64').length,
                  })),
                },
              });
            }
            if (loseResponse) throw new Error('connection lost after send');
            // Like the installed runtime: the owner stores the acceptance and its ID is cited.
            const sent = mailbox.find(
              (m) => m.data.rfcMessageId === messageId,
            )!;

            return {
              evidenceRefs: [
                await binding.storeReceipt(ctx, action, {
                  provider: 'gmail',
                  connectionId: action.connectionId,
                  capability: 'messages.send',
                  adapterVersion: 'fake-mailbox/1',
                  dispatchIdentity: 'fake-mailbox/1',
                  idempotencyKey,
                  acceptedAt: new Date().toISOString(),
                  providerRequestId: null,
                  records: [
                    { resource: 'message', externalId: sent.providerMessageId },
                  ],
                }),
              ],
            };
          },
          verify: (action) => binding.verify(ctx, action),
        };

        return adapter;
      },
    }),
  };
  const connection: MailboxConnection = {
    id: connectionId,
    label: 'Operations mailbox',
    provider: 'gmail',
    status: 'active',
    version: 1,
    address: 'ops@shop.example',
    canRead: true,
    canSend: true,
    installerId: aliceId,
  };
  const records: RecordStates = {
    async read(ctx, refs) {
      return new Map(
        refs
          .filter(
            (r) => r.kind === 'order' && ctx.permissions.has('orders.read'),
          )
          .map((r) => [
            `order:${r.id}`,
            {
              kind: 'order' as const,
              label: '1001',
              observedAt: new Date().toISOString(),
              status: 'open',
              paymentStatus: 'paid',
              fulfillment: 'unfulfilled' as const,
              dueAt: null,
              tracking: [],
            },
          ]),
      );
    },
  };
  let messaging: ReturnType<typeof createMessaging>;
  let procurement: ReturnType<typeof createProcurement>;
  let safety: ReturnType<typeof createSafetyServices>;
  let threadId: string;

  beforeAll(async () => {
    await admin.query(`CREATE DATABASE "${name}"`);
    const url = new URL(databaseUrl!);
    url.pathname = `/${name}`;
    owner = new Pool({ connectionString: url.toString() });
    // Dropping the database at the end terminates idle connections.
    owner.on('error', () => undefined);
    const setup = await admin.connect();
    try {
      await setup.query(
        "SELECT pg_advisory_lock(hashtext('luma_test_role_setup'))",
      );
      for (const file of (
        await readdir(new URL('../migrations/', import.meta.url))
      ).sort())
        if (file.endsWith('.sql'))
          await owner.query(
            await readFile(
              new URL(`../migrations/${file}`, import.meta.url),
              'utf8',
            ),
          );
    } finally {
      await setup.query(
        "SELECT pg_advisory_unlock(hashtext('luma_test_role_setup'))",
      );
      setup.release();
    }
    await owner.query('SELECT luma_provision_cell_region($1)', ['AU']);
    const password = randomUUID();
    await admin.query(
      `CREATE ROLE "${name}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
    );
    // The API login's messaging and safety roles, never the owner's.
    await admin.query(
      `GRANT luma_desk,luma_policies,luma_execution,luma_audit TO "${name}"`,
    );
    url.username = name;
    url.password = password;
    runtime = new Pool({ connectionString: url.toString(), max: 8 });
    runtime.on('error', () => undefined);

    for (const id of [tenant, otherTenant])
      await owner.query(
        "INSERT INTO organizations(data_region,id,name,slug,status,created_at,write_mode) VALUES('AU',$1,'Shop',$2,'active',now(),'writes_enabled')",
        [id, `shop-${id}`],
      );
    await owner.query(
      "INSERT INTO connector_installations(tenant_id,id,version,document,secret) VALUES($1,$2,1,$3,'secret')",
      [
        tenant,
        connectionId,
        { tenantId: tenant, id: connectionId, version: 1, status: 'active' },
      ],
    );

    const database = createTenantDatabase(runtime);
    procurement = createProcurement(database, async (c) => c, createAuditLog);
    const effects = createReplyEffects(sender, () => messaging.replies);
    safety = createSafetyServices(
      database,
      { refreshContext: async (c) => c },
      effects,
      { eligible: (c, step) => messaging.replies.eligible(c, step) },
    );
    const contexts = new Map<string, () => TenantContext>([
      [aliceId, alice],
      [bobId, bob],
    ]);
    rebuildMessaging = () =>
      createMessaging(database, {
        audit: createAuditLog,
        refreshContext: async (c) => c,
        resolveContext: async (userId, tenantId) => {
          const make = contexts.get(userId);
          if (!make || tenantId !== tenant) throw new Error('unknown');

          return make();
        },
        connections: {
          list: async (c) => (c.tenantId === tenant ? [connection] : []),
        },
        directory: createRecordDirectory(database),
        members: { canReadMessages: async () => true },
        reader,
        records,
        documents: {
          directory: { skus: async () => new Set(), suppliers: async () => [] },
          attachments: {
            read: async (_context, _connection, input) => {
              const index = Number(input.attachment.externalId);
              const outboundId = mailbox
                .find(
                  (item) => item.providerMessageId === input.message.externalId,
                )
                ?.data.rfcMessageId?.split('@')[0]
                ?.slice(5);
              const result = await owner.query<{
                document: { attachments?: { base64: string }[] };
              }>(
                'SELECT document FROM messaging_outbound WHERE tenant_id=$1 AND id=$2',
                [tenant, outboundId],
              );
              const file = result.rows[0]?.document.attachments?.[index];

              return file
                ? {
                    ok: true,
                    bytes: corruptAttachment
                      ? new Uint8Array(
                          Buffer.from(file.base64, 'base64').length,
                        ).fill(1)
                      : Buffer.from(file.base64, 'base64'),
                    sha256: null,
                  }
                : { ok: false, code: 'not_found' };
            },
          },
        },
        replyAdmission: createReplyAdmission(safety, effects),
        settled: async (_context, outbound) => {
          supplierEvents.push({ id: outbound.id, state: outbound.state });
        },
      });

    messaging = rebuildMessaging();
    await messaging.service.mailboxes(alice());
    await messaging.service.addRule(alice(), connectionId, {
      id: randomUUID(),
      kind: 'sender_domain',
      value: 'acme.example',
      party: { kind: 'other' },
    });
    for (const scope of await messaging.sync!.scopes())
      await messaging.sync!.tick(scope);
    threadId = (
      await owner.query<{ id: string }>(
        "SELECT id FROM messaging_threads WHERE tenant_id=$1 AND provider_thread_id='t1'",
        [tenant],
      )
    ).rows[0]!.id;
  }, 60_000);

  beforeEach(() => {
    loseResponse = false;
    hideThread = false;
    partialThread = false;
    endlessThread = false;
    corruptAttachment = false;
    staleObservation = false;
  });

  afterAll(async () => {
    await safety?.close();
    await runtime?.end();
    await owner?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.query(`DROP ROLE IF EXISTS "${name}"`);
    await admin.end();
  });

  /** Drafts a reply as Alice and replaces its text. */
  async function draft(text: string) {
    const drafted = await messaging.replies.draft(alice(), threadId, {
      id: randomUUID(),
    });

    return messaging.replies.update(alice(), drafted.id, {
      expectedRevision: drafted.revision,
      to: drafted.to.map((a) => a.address),
      cc: [],
      subject: drafted.subject,
      text,
    });
  }

  async function sendCount(outboundId: string) {
    return sends.filter((id) => id === outboundId).length;
  }

  async function supplierDraft() {
    const supplierId = randomUUID();
    const purchaseOrderId = randomUUID();
    const id = randomUUID();
    await owner.query(
      'INSERT INTO procurement_suppliers(tenant_id,id,document) VALUES($1,$2,$3)',
      [
        tenant,
        supplierId,
        {
          id: supplierId,
          tenantId: tenant,
          name: 'Acme',
          externalReferences: [],
          createdAt: new Date().toISOString(),
        },
      ],
    );
    await owner.query(
      'INSERT INTO procurement_purchase_orders(tenant_id,id,supplier_id,document,created_at) VALUES($1,$2,$3,$4,now())',
      [
        tenant,
        purchaseOrderId,
        supplierId,
        {
          id: purchaseOrderId,
          tenantId: tenant,
          supplierId,
          supplierName: 'Acme',
          reference: `PO-${id}`,
          authority: 'luma',
          externalReferences: [],
          origin: {},
          status: 'draft',
          revision: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lines: [
            {
              id: randomUUID(),
              sku: 'SKU-1',
              description: 'Item',
              quantity: 40,
              unit: 'each',
            },
          ],
        },
      ],
    );
    const input = {
      id,
      connectionId,
      to: [anna],
      subject: `Purchase order PO-${id}`,
      text: 'Please confirm the attached order.',
      language: 'en' as const,
      records: [
        { kind: 'purchase_order' as const, id: purchaseOrderId },
        { kind: 'supplier' as const, id: supplierId },
      ],
      attachments: [
        {
          filename: 'order.pdf',
          mimeType: 'application/pdf',
          base64: Buffer.from('%PDF sample').toString('base64'),
        },
      ],
      procurement: {
        purchaseOrderId,
        supplierId,
        kind: 'submission' as const,
        requestedDeliveryDate: '2026-10-20',
      },
    };

    return {
      input,
      reply: await messaging.replies.compose(alice(), input),
      purchaseOrderId,
    };
  }

  it('edits supplier contact with audit, revision checks, idempotent retries and tenant isolation', async () => {
    const supplier = await procurement.createSupplier(alice(), {
      id: randomUUID(),
      name: 'Supplier contact',
      externalReferences: [],
    });
    const request = {
      id: randomUUID(),
      expectedRevision: 1,
      email: 'orders@supplier.example',
      language: 'de',
    };
    const updated = await procurement.updateSupplierContact(
      alice(),
      supplier.id,
      request,
    );
    expect(updated).toMatchObject({
      email: request.email,
      language: 'de',
      revision: 2,
    });
    expect(
      await procurement.updateSupplierContact(alice(), supplier.id, request),
    ).toEqual(updated);
    await expect(
      procurement.updateSupplierContact(alice(), supplier.id, {
        ...request,
        id: randomUUID(),
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      procurement.updateSupplierContact(alice(), supplier.id, {
        ...request,
        email: 'other@supplier.example',
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      procurement.updateSupplierContact(
        context(memberId, 'member'),
        supplier.id,
        { ...request, id: randomUUID(), expectedRevision: 2 },
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      procurement.updateSupplierContact(
        context(outsiderId, 'admin', otherTenant),
        supplier.id,
        { ...request, id: randomUUID() },
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    const cleared = await procurement.updateSupplierContact(
      alice(),
      supplier.id,
      { id: randomUUID(), expectedRevision: 2, email: null, language: null },
    );
    expect(cleared.email).toBeUndefined();
    expect(cleared.language).toBeUndefined();
    const audit = await owner.query(
      "SELECT count(*)::int AS n FROM audit_entries WHERE tenant_id=$1 AND document->>'eventType'='supplier.contact_updated' AND proposal_id=$2",
      [tenant, supplier.id],
    );
    expect(audit.rows[0].n).toBe(2);
  });

  it('approves a supplier PDF, sends once after a process restart, and keeps the linked order thread', async () => {
    const { input, reply, purchaseOrderId } = await supplierDraft();
    expect(await messaging.replies.compose(alice(), input)).toMatchObject({
      id: reply.id,
      state: 'draft',
    });
    const pdf = await messaging.replies.supplierAttachment(
      alice(),
      purchaseOrderId,
      reply.id,
    );
    expect(Buffer.from(pdf.base64, 'base64').toString()).toBe('%PDF sample');
    const requested = await messaging.replies.request(alice(), reply.id, {
      id: randomUUID(),
    });
    expect(requested.state).toBe('approval_required');
    expect(await sendCount(reply.id)).toBe(0);
    await expect(
      messaging.replies.decide(alice(), reply.id, {
        decisionId: requested.decisionId!,
        outcome: 'approved',
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    messaging = rebuildMessaging();
    const sent = await messaging.replies.decide(bob(), reply.id, {
      decisionId: requested.decisionId!,
      outcome: 'approved',
    });
    expect(sent.state).toBe('sent');
    messaging = rebuildMessaging();
    await messaging.replies.pass(alice());
    await messaging.replies.send(alice(), reply.id, { id: randomUUID() });
    expect(await sendCount(reply.id)).toBe(1);
    expect(
      (
        await messaging.service.recordThreads(
          alice(),
          'purchase_order',
          purchaseOrderId,
        )
      ).items,
    ).toHaveLength(1);
    expect(
      supplierEvents.filter(
        (event) => event.id === reply.id && event.state === 'sent',
      ),
    ).toHaveLength(1);
    const detail = await messaging.service.thread(alice(), reply.threadId);
    expect(detail.messages).toHaveLength(1);
    expect(detail.documents[0]?.filename).toBe('order.pdf');
    const followUp = await messaging.replies.compose(alice(), {
      ...input,
      id: randomUUID(),
      threadId: reply.threadId,
      subject: 'A proposed new subject must not split the supplier thread',
      attachments: [],
      procurement: {
        ...input.procurement,
        kind: 'follow_up',
        attentionKey: 'confirmation_overdue:current',
        nextCheckAt: '2026-10-21T00:00:00Z',
      },
    });
    expect(followUp.subject).toBe(`Re: ${input.subject}`);
    expect(followUp.threadId).toBe(reply.threadId);
    await expect(
      messaging.replies.supplierAttachment(
        context(outsiderId, 'admin', otherTenant),
        purchaseOrderId,
        reply.id,
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      messaging.replies.compose(alice(), { ...input, id: randomUUID() }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('requires independently read attachment bytes to match the approved PDF', async () => {
    const { reply } = await supplierDraft();
    const requested = await messaging.replies.request(alice(), reply.id, {
      id: randomUUID(),
    });
    loseResponse = true;
    expect(
      await messaging.replies.decide(bob(), reply.id, {
        decisionId: requested.decisionId!,
        outcome: 'approved',
      }),
    ).toMatchObject({ state: 'uncertain' });
    corruptAttachment = true;
    expect(await messaging.replies.check(alice(), reply.id)).toMatchObject({
      state: 'uncertain',
    });
    corruptAttachment = false;
    expect(await messaging.replies.check(alice(), reply.id)).toMatchObject({
      state: 'sent',
    });
    expect(await sendCount(reply.id)).toBe(1);
  });

  it('reconciles an uncertain supplier send after restart and records a permanent bounce independently', async () => {
    const { reply, purchaseOrderId } = await supplierDraft();
    const requested = await messaging.replies.request(alice(), reply.id, {
      id: randomUUID(),
    });
    loseResponse = true;
    await messaging.replies.decide(bob(), reply.id, {
      decisionId: requested.decisionId!,
      outcome: 'approved',
    });
    messaging = rebuildMessaging();
    loseResponse = false;
    const checked = await messaging.replies.check(alice(), reply.id);
    expect(checked.state).toBe('sent');
    expect(await sendCount(reply.id)).toBe(1);
    const at = new Date().toISOString();
    mailbox.push({
      providerMessageId: `bounce-${reply.id}`,
      data: {
        thread: { externalId: `new-${reply.id}`, scopeKey: '' },
        rfcMessageId: `bounce.${reply.id}@mail.example`,
        inReplyTo: `luma.${reply.id}@shop.example`,
        references: [],
        direction: 'inbound',
        from: { address: 'mailer-daemon@mail.example', name: null },
        senderAuthentication: 'aligned',
        to: [ops],
        cc: [],
        replyTo: [],
        subject: 'Delivery failure',
        text: 'Permanent failure',
        truncated: false,
        sentAt: at,
        receivedAt: at,
        labels: ['INBOX'],
        attachments: [],
        deliveryFailure: {
          originalMessageId: `luma.${reply.id}@shop.example`,
          recipient: anna.address,
          status: '5.1.1',
        },
      },
    });
    await messaging.store.transaction(tenant, async (tx) => {
      const row = await tx.outbound.get(reply.id, true);
      if (row)
        await tx.outbound.update({
          ...row,
          document: {
            ...row.document,
            deliveryCheckedAt: '2026-01-01T00:00:00Z',
          },
        });
    });
    await messaging.replies.pass(alice());
    expect(await messaging.replies.get(alice(), reply.id)).toMatchObject({
      state: 'failed',
    });
    expect(
      supplierEvents.some(
        (event) => event.id === reply.id && event.state === 'failed',
      ),
    ).toBe(true);
    expect(await sendCount(reply.id)).toBe(1);
    expect(
      (
        await messaging.service.recordThreads(
          alice(),
          'purchase_order',
          purchaseOrderId,
        )
      ).items,
    ).toHaveLength(1);
  });

  it('leaves a supplier send uncertain on a delivery report from an unauthenticated sender', async () => {
    const { reply } = await supplierDraft();
    const requested = await messaging.replies.request(alice(), reply.id, {
      id: randomUUID(),
    });
    await messaging.replies.decide(bob(), reply.id, {
      decisionId: requested.decisionId!,
      outcome: 'approved',
    });
    expect((await messaging.replies.check(alice(), reply.id)).state).toBe(
      'sent',
    );
    const at = new Date().toISOString();
    mailbox.push({
      providerMessageId: `forged-bounce-${reply.id}`,
      data: {
        thread: { externalId: `new-${reply.id}`, scopeKey: '' },
        rfcMessageId: `forged.${reply.id}@attacker.example`,
        inReplyTo: `luma.${reply.id}@shop.example`,
        references: [],
        direction: 'inbound',
        from: { address: 'mailer-daemon@attacker.example', name: null },
        senderAuthentication: 'unaligned',
        to: [ops],
        cc: [],
        replyTo: [],
        subject: 'Delivery failure',
        text: 'Permanent failure',
        truncated: false,
        sentAt: at,
        receivedAt: at,
        labels: ['INBOX'],
        attachments: [],
        deliveryFailure: {
          originalMessageId: `luma.${reply.id}@shop.example`,
          recipient: anna.address,
          status: '5.1.1',
        },
      },
    });
    await messaging.store.transaction(tenant, async (tx) => {
      const row = await tx.outbound.get(reply.id, true);
      if (row)
        await tx.outbound.update({
          ...row,
          document: {
            ...row.document,
            deliveryCheckedAt: '2026-01-01T00:00:00Z',
          },
        });
    });
    await messaging.replies.pass(alice());
    // Reading the thread again proves acceptance only; it must not settle delivery.
    await messaging.replies.pass(alice());
    await messaging.replies.check(alice(), reply.id);
    const uncertain = await messaging.replies.get(alice(), reply.id);
    expect(uncertain.state).toBe('uncertain');
    expect(uncertain.stateReason).toContain('could not verify');
    expect(
      supplierEvents
        .filter((event) => event.id === reply.id)
        .map((e) => e.state),
    ).toContain('uncertain');
    expect(
      supplierEvents.some(
        (event) => event.id === reply.id && event.state === 'failed',
      ),
    ).toBe(false);
    expect(await sendCount(reply.id)).toBe(1);
  });

  /** Pushes a message into the supplier send's provider thread. */
  function pushToSend(
    outboundId: string,
    key: string,
    data: Partial<MessageData>,
  ) {
    const at = new Date().toISOString();
    mailbox.push({
      providerMessageId: `${key}-${outboundId}`,
      data: {
        thread: { externalId: `new-${outboundId}`, scopeKey: '' },
        rfcMessageId: `${key}.${outboundId}@acme.example`,
        inReplyTo: `luma.${outboundId}@shop.example`,
        references: [`luma.${outboundId}@shop.example`],
        direction: 'inbound',
        from: anna,
        senderAuthentication: 'aligned',
        to: [ops],
        cc: [],
        replyTo: [],
        subject: 'Re: Purchase order',
        text: 'Thanks, we received the order.',
        truncated: false,
        sentAt: at,
        receivedAt: at,
        labels: ['INBOX'],
        attachments: [],
        ...data,
      },
    });
  }

  /** Makes the next supplier mail pass read the send's thread again. */
  async function readSendAgain(outboundId: string) {
    await messaging.store.transaction(tenant, async (tx) => {
      const row = await tx.outbound.get(outboundId, true);
      if (row)
        await tx.outbound.update({
          ...row,
          document: {
            ...row.document,
            deliveryCheckedAt: '2026-01-01T00:00:00Z',
          },
        });
    });
    await messaging.replies.pass(alice());
  }

  /** A sent supplier email that an unauthenticated delivery report made uncertain. */
  async function uncertainSupplierSend() {
    const drafted = await supplierDraft();
    const requested = await messaging.replies.request(
      alice(),
      drafted.reply.id,
      {
        id: randomUUID(),
      },
    );
    await messaging.replies.decide(bob(), drafted.reply.id, {
      decisionId: requested.decisionId!,
      outcome: 'approved',
    });
    await messaging.replies.check(alice(), drafted.reply.id);
    pushToSend(drafted.reply.id, 'forged-report', {
      from: { address: 'mailer-daemon@attacker.example', name: null },
      senderAuthentication: 'unaligned',
      subject: 'Delivery failure',
      text: 'Permanent failure',
      deliveryFailure: {
        originalMessageId: `luma.${drafted.reply.id}@shop.example`,
        recipient: anna.address,
        status: '5.1.1',
      },
    });
    await readSendAgain(drafted.reply.id);
    const reply = await messaging.replies.get(alice(), drafted.reply.id);
    expect(reply).toMatchObject({
      state: 'uncertain',
      canResolveDelivery: true,
      delivery: {
        report: { recipient: anna.address, status: '5.1.1' },
        resolution: null,
      },
    });

    return { ...drafted, reply };
  }

  it('lets a person mark an uncertain supplier send as not delivered, once and with authority', async () => {
    const { reply } = await uncertainSupplierSend();
    const member = context(memberId, 'member');
    const decision = {
      id: randomUUID(),
      expectedRevision: reply.revision,
      outcome: 'not_delivered' as const,
      note: '  Spoke to Anna; nothing arrived. ',
    };

    expect(
      (await messaging.replies.get(member, reply.id)).canResolveDelivery,
    ).toBe(false);
    await expect(
      messaging.replies.resolveDelivery(member, reply.id, decision),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      messaging.replies.resolveDelivery(
        context(outsiderId, 'admin', otherTenant),
        reply.id,
        decision,
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      messaging.replies.resolveDelivery(bob(), reply.id, {
        ...decision,
        expectedRevision: reply.revision - 1,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });

    // Someone other than the requester decides; procurement hears as the requester.
    const resolved = await messaging.replies.resolveDelivery(
      bob(),
      reply.id,
      decision,
    );
    expect(resolved).toMatchObject({
      state: 'failed',
      canResolveDelivery: false,
      stateReason: expect.stringContaining('did not arrive'),
      delivery: {
        resolution: {
          outcome: 'not_delivered',
          source: 'person',
          by: bobId,
          note: 'Spoke to Anna; nothing arrived.',
        },
      },
    });
    expect(
      await messaging.replies.resolveDelivery(bob(), reply.id, decision),
    ).toMatchObject({ state: 'failed', revision: resolved.revision });
    await expect(
      messaging.replies.resolveDelivery(bob(), reply.id, {
        ...decision,
        outcome: 'delivered',
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      messaging.replies.resolveDelivery(bob(), reply.id, {
        ...decision,
        id: randomUUID(),
        expectedRevision: resolved.revision,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(supplierEvents.filter((e) => e.id === reply.id).at(-1)).toEqual({
      id: reply.id,
      state: 'failed',
    });
    expect(
      (await messaging.service.thread(alice(), reply.threadId)).events,
    ).toContainEqual(
      expect.objectContaining({
        type: 'delivery_resolved',
        actor: { kind: 'user', id: bobId },
        details: expect.objectContaining({
          outcome: 'not_delivered',
          source: 'person',
        }),
      }),
    );
    const audits = await owner.query<{
      document: { details: Record<string, string> };
    }>(
      "SELECT document FROM audit_entries WHERE tenant_id=$1 AND document->>'eventType'='messaging.reply.delivery_resolved' AND proposal_id=$2",
      [tenant, reply.id],
    );
    expect(audits.rows.map((r) => r.document.details)).toEqual([
      expect.objectContaining({
        outcome: 'not_delivered',
        source: 'person',
        unverifiedReport: 'yes',
      }),
    ]);
    expect(await sendCount(reply.id)).toBe(1);
  });

  it('lets a person mark an uncertain supplier send as delivered and keeps that against later unverified reports', async () => {
    const { reply } = await uncertainSupplierSend();
    const resolved = await messaging.replies.resolveDelivery(
      alice(),
      reply.id,
      {
        id: randomUUID(),
        expectedRevision: reply.revision,
        outcome: 'delivered',
      },
    );
    expect(resolved).toMatchObject({
      state: 'sent',
      delivery: {
        resolution: { outcome: 'delivered', by: aliceId, note: null },
      },
    });
    expect(supplierEvents.filter((e) => e.id === reply.id).at(-1)).toEqual({
      id: reply.id,
      state: 'sent',
    });

    pushToSend(reply.id, 'second-forged-report', {
      from: { address: 'mailer-daemon@attacker.example', name: null },
      senderAuthentication: 'unaligned',
      subject: 'Delivery failure',
      text: 'Permanent failure',
      deliveryFailure: {
        originalMessageId: `luma.${reply.id}@shop.example`,
        recipient: anna.address,
        status: '5.1.1',
      },
    });
    await readSendAgain(reply.id);
    expect(await messaging.replies.get(alice(), reply.id)).toMatchObject({
      state: 'sent',
    });
    expect(await sendCount(reply.id)).toBe(1);
  });

  it('refuses a delivery decision for replies that are not supplier emails', async () => {
    const reply = await draft('Thanks, noted again.');
    loseResponse = true;
    const uncertain = await messaging.replies.request(alice(), reply.id, {
      id: randomUUID(),
    });
    loseResponse = false;
    expect(uncertain).toMatchObject({
      state: 'uncertain',
      canResolveDelivery: false,
    });
    await expect(
      messaging.replies.resolveDelivery(alice(), reply.id, {
        id: randomUUID(),
        expectedRevision: uncertain.revision,
        outcome: 'delivered',
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('settles an uncertain supplier send when the supplier replies from an authenticated address', async () => {
    const { reply } = await uncertainSupplierSend();
    // Unauthenticated replies and replies to another message prove nothing.
    pushToSend(reply.id, 'unaligned-reply', {
      senderAuthentication: 'unaligned',
    });
    pushToSend(reply.id, 'other-reply', {
      inReplyTo: 'other.message@acme.example',
      references: [
        `luma.${reply.id}@shop.example`,
        'other.message@acme.example',
      ],
    });
    pushToSend(reply.id, 'stranger-reply', {
      from: { address: 'stranger@elsewhere.example', name: null },
    });
    await readSendAgain(reply.id);
    expect(await messaging.replies.get(alice(), reply.id)).toMatchObject({
      state: 'uncertain',
    });

    pushToSend(reply.id, 'reply', {});
    await readSendAgain(reply.id);
    const settled = await messaging.replies.get(alice(), reply.id);
    expect(settled).toMatchObject({
      state: 'sent',
      stateReason: expect.stringContaining('replied'),
      delivery: {
        resolution: { outcome: 'delivered', source: 'reply', by: null },
      },
    });
    expect(supplierEvents.filter((e) => e.id === reply.id).at(-1)).toEqual({
      id: reply.id,
      state: 'sent',
    });
    expect(
      (await messaging.service.thread(alice(), reply.threadId)).events,
    ).toContainEqual(
      expect.objectContaining({
        type: 'delivery_resolved',
        actor: { kind: 'luma', id: 'luma' },
        details: expect.objectContaining({ source: 'reply' }),
      }),
    );
    expect(
      (
        await owner.query(
          "SELECT 1 FROM audit_entries WHERE tenant_id=$1 AND document->>'eventType'='messaging.reply.delivery_resolved' AND proposal_id=$2",
          [tenant, reply.id],
        )
      ).rowCount,
    ).toBe(1);
    expect(await sendCount(reply.id)).toBe(1);
  });

  it('drafts from linked records with citations', async () => {
    // Order projections belong to another owner; the link is what drafting reads.
    await owner.query(
      `INSERT INTO messaging_links(tenant_id,id,thread_id,record_kind,record_id,method,state,evidence,created_by,created_at)
      VALUES($1,$2,$3,'order',$4,'manual','active',$5,$6,now())`,
      [
        tenant,
        randomUUID(),
        threadId,
        orderId,
        { messageId: null, ruleId: null, text: null, span: null },
        aliceId,
      ],
    );
    const drafted = await messaging.replies.draft(alice(), threadId, {
      id: randomUUID(),
    });

    expect(drafted).toMatchObject({
      state: 'draft',
      to: [{ address: 'anna@acme.example', name: 'Anna' }],
      subject: 'Re: Order 1001',
      consequential: [],
      canEdit: true,
      canRequest: true,
    });
    expect(drafted.text).toContain('Hello Anna,');
    expect(drafted.text).toContain('Order 1001 has not shipped yet.');
    expect(drafted.citations).toEqual([
      expect.objectContaining({
        record: { kind: 'order', id: orderId, label: null },
        freshness: 'fresh',
      }),
    ]);
    // Bob sees the draft but cannot change or send Alice's reply.
    expect(
      (await messaging.service.thread(bob(), threadId)).outbound.find(
        (o) => o.id === drafted.id,
      ),
    ).toMatchObject({ canEdit: false, canRequest: false });
    await expect(
      messaging.replies.request(bob(), drafted.id, { id: randomUUID() }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('sends a low-risk reply once and verifies it by reading the thread', async () => {
    const reply = await draft('Thanks, we are checking this for you.');
    const command = randomUUID();
    const sent = await messaging.replies.request(alice(), reply.id, {
      id: command,
    });

    expect(sent).toMatchObject({ state: 'sent', consequential: [] });
    expect(await sendCount(reply.id)).toBe(1);
    expect(
      await messaging.replies.request(alice(), reply.id, { id: command }),
    ).toMatchObject({ state: 'sent' });
    expect(
      await messaging.replies.send(alice(), reply.id, { id: randomUUID() }),
    ).toMatchObject({ state: 'sent' });
    expect(await sendCount(reply.id)).toBe(1);

    const detail = await messaging.service.thread(alice(), threadId);
    const message = detail.messages.find((m) => m.id === sent.sentMessageId);
    expect(message).toMatchObject({
      direction: 'outbound',
      origin: 'luma',
      source: { rfcMessageId: `luma.${reply.id}@shop.example` },
    });
    expect(detail.thread).toMatchObject({
      awaitingReply: false,
      replyDueAt: null,
    });
    expect(detail.events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['reply_requested', 'sent']),
    );
    const executed = await safety.execution.get(
      alice(),
      (await action(reply.id))!,
    );
    expect(executed?.state).toBe('succeeded');

    // The cited send receipt resolves to exactly one stored, append-only, tenant-scoped row.
    const refs =
      executed && 'record' in executed
        ? (executed.record.attempt.effectEvidenceRefs ?? [])
        : [];
    expect(refs).toHaveLength(1);
    const database = createTenantDatabase(runtime);
    await database.transaction(tenant, async (tx) => {
      const stored = await tx.query<{
        id: string;
        outbound_id: string;
        connection_id: string;
        document: Record<string, unknown>;
      }>(
        'SELECT id,outbound_id,connection_id,document FROM messaging_send_receipts WHERE id=ANY($1::uuid[])',
        [refs],
      );
      expect(stored.rows).toEqual([
        {
          id: refs[0],
          outbound_id: reply.id,
          connection_id: connectionId,
          document: expect.objectContaining({
            kind: 'write_receipt',
            tenantId: tenant,
            outboundId: reply.id,
            status: 'accepted',
            source: { provider: 'gmail', connectionId },
            idempotencyKey: expect.stringContaining((await action(reply.id))!),
            records: [{ resource: 'message', externalId: expect.any(String) }],
          }),
        },
      ]);
      // Recipients, subject and text are never part of the receipt.
      expect(JSON.stringify(stored.rows[0]!.document)).not.toContain(
        'checking this for you',
      );
    });
    for (const statement of [
      'DELETE FROM messaging_send_receipts WHERE id=$1',
      "UPDATE messaging_send_receipts SET document=document||'{}' WHERE id=$1",
    ])
      await expect(
        database.transaction(tenant, (tx) =>
          tx.query(statement, refs).then(() => {}),
        ),
      ).rejects.toThrow('permission denied');
    await database.transaction(otherTenant, async (tx) => {
      expect(
        (await tx.query('SELECT id FROM messaging_send_receipts')).rows,
      ).toEqual([]);
    });
    await expect(
      database.transaction(otherTenant, (tx) =>
        tx
          .query(
            `INSERT INTO messaging_send_receipts(tenant_id,id,outbound_id,connection_id,accepted_at,document)
             VALUES($1,$2,$3,$4,now(),$5)`,
            [
              tenant,
              randomUUID(),
              reply.id,
              connectionId,
              { tenantId: tenant, outboundId: reply.id },
            ],
          )
          .then(() => {}),
      ),
    ).rejects.toThrow('row-level security');
  });

  it('ignores cached matches when a fresh read is empty or incomplete', async () => {
    const reply = await draft('Thanks, we are checking.');
    const sent = await messaging.replies.request(alice(), reply.id, {
      id: randomUUID(),
    });
    expect(sent.state).toBe('sent');
    hideThread = true;
    expect((await messaging.replies.verify(alice(), reply.id)).outcome).toBe(
      'inconclusive',
    );
    hideThread = false;
    partialThread = true;
    expect((await messaging.replies.verify(alice(), reply.id)).outcome).toBe(
      'inconclusive',
    );
    partialThread = false;
    endlessThread = true;
    expect((await messaging.replies.verify(alice(), reply.id)).outcome).toBe(
      'inconclusive',
    );
    endlessThread = false;
    staleObservation = true;
    expect((await messaging.replies.verify(alice(), reply.id)).outcome).toBe(
      'inconclusive',
    );
    expect(sends.filter((id) => id === reply.id)).toHaveLength(1);
  });

  it.each([
    'inbound',
    'wrong-domain',
    'recipients',
    'body',
    'subject',
    'attachments',
    'provider-sent',
  ] as const)('rejects conflicting fresh send evidence: %s', async (change) => {
    const reply = await draft('Thanks, we are checking.');
    await messaging.replies.request(alice(), reply.id, { id: randomUUID() });
    const item = mailbox.find(
      (item) => item.data.rfcMessageId === `luma.${reply.id}@shop.example`,
    )!;
    const original = structuredClone(item.data);
    try {
      if (change === 'inbound') item.data.direction = 'inbound';
      if (change === 'wrong-domain')
        item.data.rfcMessageId = `luma.${reply.id}@wrong.example`;
      if (change === 'recipients') item.data.to = [ops];
      if (change === 'body') item.data.text = 'Different body';
      if (change === 'subject') item.data.subject = 'Different subject';
      if (change === 'attachments')
        item.data.attachments = [
          {
            attachment: { externalId: 'extra', scopeKey: '' },
            filename: 'extra.txt',
            mimeType: 'text/plain',
            size: 1,
          },
        ];
      if (change === 'provider-sent') item.data.providerSent = false;
      expect((await messaging.replies.verify(alice(), reply.id)).outcome).toBe(
        'inconclusive',
      );
      expect(sends.filter((id) => id === reply.id)).toHaveLength(1);
    } finally {
      item.data = original;
    }
  });

  it('needs someone else to approve a consequential reply before sending it', async () => {
    const reply = await draft('We refund 20 EUR and ship on Monday.');
    expect(reply.consequential).toEqual(['date', 'money']);
    await expect(
      messaging.replies.update(alice(), reply.id, {
        expectedRevision: reply.revision - 1,
        to: ['anna@acme.example'],
        cc: [],
        subject: reply.subject,
        text: 'Changed',
      }),
    ).rejects.toMatchObject({ statusCode: 409 });

    const requested = await messaging.replies.request(alice(), reply.id, {
      id: randomUUID(),
    });
    expect(requested).toMatchObject({
      state: 'approval_required',
      canApprove: false,
      canEdit: false,
    });
    expect(requested.decisionId).toBeTruthy();
    expect(await sendCount(reply.id)).toBe(0);
    await expect(
      messaging.replies.update(alice(), reply.id, {
        expectedRevision: requested.revision,
        to: ['anna@acme.example'],
        cc: [],
        subject: reply.subject,
        text: 'Changed after the request',
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      messaging.replies.decide(alice(), reply.id, {
        decisionId: requested.decisionId!,
        outcome: 'approved',
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      messaging.replies.decide(context(memberId, 'member'), reply.id, {
        decisionId: requested.decisionId!,
        outcome: 'approved',
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(
      (await messaging.replies.pending(bob())).find(
        (p) => p.outboundId === reply.id,
      ),
    ).toMatchObject({ state: 'approval_required', response: 'decide' });
    expect(
      (await messaging.replies.pending(alice())).find(
        (p) => p.outboundId === reply.id,
      ),
    ).toMatchObject({ response: 'awaiting_other' });

    const approved = await messaging.replies.decide(bob(), reply.id, {
      decisionId: requested.decisionId!,
      outcome: 'approved',
    });
    expect(approved).toMatchObject({ state: 'sent', approverId: bobId });
    expect(await sendCount(reply.id)).toBe(1);
    expect(
      (await messaging.service.thread(alice(), threadId)).events.map(
        (e) => e.type,
      ),
    ).toContain('reply_approved');
    expect(
      (await messaging.replies.pending(bob())).map((p) => p.outboundId),
    ).not.toContain(reply.id);
  });

  it('withholds a reply whose stored text changed after the request', async () => {
    const reply = await draft('We confirm 40 units.');
    const requested = await messaging.replies.request(alice(), reply.id, {
      id: randomUUID(),
    });
    await owner.query(
      `UPDATE messaging_outbound SET document=jsonb_set(document,'{text}','"We confirm 400 units."')
      WHERE tenant_id=$1 AND id=$2`,
      [tenant, reply.id],
    );
    const decided = await messaging.replies.decide(bob(), reply.id, {
      decisionId: requested.decisionId!,
      outcome: 'approved',
    });

    expect(decided).toMatchObject({
      state: 'withheld',
      stateReason: expect.stringContaining('Nothing was sent'),
    });
    expect(await sendCount(reply.id)).toBe(0);
  });

  it('reconciles a lost response by reading and never sends twice', async () => {
    const reply = await draft('Thanks, noted.');
    loseResponse = true;
    const uncertain = await messaging.replies.request(alice(), reply.id, {
      id: randomUUID(),
    });

    expect(uncertain).toMatchObject({ state: 'uncertain', canCheck: true });
    expect(await sendCount(reply.id)).toBe(1);
    loseResponse = false;
    expect(
      await messaging.replies.send(alice(), reply.id, { id: randomUUID() }),
    ).toMatchObject({ state: 'uncertain' });
    expect(
      (await messaging.replies.pending(alice())).find(
        (p) => p.outboundId === reply.id,
      ),
    ).toMatchObject({ state: 'uncertain', response: 'check' });

    const checked = await messaging.replies.check(alice(), reply.id);
    expect(checked).toMatchObject({ state: 'sent' });
    expect(checked.sentMessageId).toBeTruthy();
    await messaging.replies.check(alice(), reply.id);
    await messaging.replies.pass(alice());
    expect(await sendCount(reply.id)).toBe(1);

    // A lost response has no receipt: nothing is stored and the attempt cites none.
    const executed = await safety.execution.get(
      alice(),
      (await action(reply.id))!,
    );
    expect(
      executed && 'record' in executed
        ? (executed.record.attempt.effectEvidenceRefs ?? [])
        : null,
    ).toEqual([]);
    expect(
      (
        await owner.query(
          'SELECT id FROM messaging_send_receipts WHERE tenant_id=$1 AND outbound_id=$2',
          [tenant, reply.id],
        )
      ).rows,
    ).toEqual([]);
  });

  it('settles an uncertain send in the background pass by reading only', async () => {
    const reply = await draft('Thanks again.');
    loseResponse = true;
    await messaging.replies.request(alice(), reply.id, { id: randomUUID() });
    loseResponse = false;
    await messaging.replies.pass(alice());

    expect(
      (await messaging.service.thread(alice(), threadId)).outbound.find(
        (o) => o.id === reply.id,
      ),
    ).toMatchObject({ state: 'sent' });
    expect(await sendCount(reply.id)).toBe(1);
  });

  it('records an observe-only send as withheld without contacting the mailbox', async () => {
    await owner.query(
      "UPDATE organizations SET write_mode='observe_only' WHERE id=$1",
      [tenant],
    );
    try {
      const reply = await draft('Thanks, we are on it.');
      const withheld = await messaging.replies.request(alice(), reply.id, {
        id: randomUUID(),
      });

      expect(withheld).toMatchObject({
        state: 'withheld',
        stateReason: expect.stringContaining('Observe-only'),
      });
      expect(await sendCount(reply.id)).toBe(0);
      expect(
        (await messaging.service.thread(alice(), threadId)).events.map(
          (e) => e.type,
        ),
      ).toContain('reply_withheld');
      expect(
        await safety.execution.get(alice(), (await action(reply.id))!),
      ).toMatchObject({ state: 'not_executed', reason: 'observe_only' });
    } finally {
      await owner.query(
        "UPDATE organizations SET write_mode='writes_enabled' WHERE id=$1",
        [tenant],
      );
    }
  });

  it('expires draft and sent body copies without attachment deadlines and withholds unsent work', async () => {
    const sent = await draft('A retained sent reply.');
    await messaging.replies.request(alice(), sent.id, { id: randomUUID() });
    const unsent = await draft('A retained draft reply.');
    await owner.query(
      `UPDATE messaging_outbound SET document=(document-'attachmentsExpireAt') || jsonb_build_object('contentRetainUntil',now()-interval '1 day') WHERE tenant_id=$1 AND id=ANY($2::uuid[])`,
      [tenant, [sent.id, unsent.id]],
    );
    await runtime.query('SELECT purge_expired_messaging(200)');
    const detail = await messaging.service.thread(alice(), threadId);
    expect(detail.outbound.find((reply) => reply.id === sent.id)).toMatchObject(
      { text: '', state: 'sent' },
    );
    expect(
      detail.outbound.find((reply) => reply.id === unsent.id),
    ).toMatchObject({ text: '', state: 'withheld', canRequest: false });
    await expect(
      messaging.replies.request(alice(), unsent.id, { id: randomUUID() }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('discards drafts and keeps replies inside their workspace and roles', async () => {
    const reply = await draft('Draft to drop.');
    expect(
      await messaging.replies.discard(alice(), reply.id, { id: randomUUID() }),
    ).toMatchObject({ state: 'discarded', canRequest: false });

    await expect(
      messaging.replies.draft(context(memberId, 'member'), threadId, {
        id: randomUUID(),
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    const outsider = context(outsiderId, 'admin', otherTenant);
    await expect(
      messaging.replies.draft(outsider, threadId, { id: randomUUID() }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      messaging.replies.request(outsider, reply.id, { id: randomUUID() }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(await messaging.replies.pending(outsider)).toEqual([]);
  });

  async function action(outboundId: string) {
    return (
      await owner.query<{ action_id: string }>(
        'SELECT action_id FROM messaging_outbound WHERE tenant_id=$1 AND id=$2',
        [tenant, outboundId],
      )
    ).rows[0]?.action_id;
  }
});
