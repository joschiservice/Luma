import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

import { createAuditLog } from '@luma/audit/composition';
import type { TenantContext } from '@luma/identity';
import {
  builtInMembership,
  makeTenantContext,
} from '@luma/identity/composition';
import type {
  MailboxConnection,
  MessageData,
  MessageReader,
  ProcurementHandoff,
} from '@luma/messaging';
import { createMessaging } from '@luma/messaging/composition';
import { createTenantDatabase } from '@luma/platform/composition';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createRecordDirectory } from './composition/messaging.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

const hour = 3_600_000;

describe.skipIf(!databaseUrl)('operations inbox on PostgreSQL', () => {
  const name = `messaging_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: databaseUrl });
  let owner: Pool;
  let runtime: Pool;
  const tenant = randomUUID();
  const otherTenant = randomUUID();
  const connectionId = randomUUID();
  const adminId = randomUUID();
  const memberId = randomUUID();
  const supplierId = randomUUID();
  const orderId = randomUUID();
  const ambiguous = [randomUUID(), randomUUID()];
  const customerId = randomUUID();
  const now = Date.now();
  const at = (offset: number) => new Date(now - offset).toISOString();

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
  const adminContext = () => context(adminId, 'admin');

  const address = (value: string, displayName: string | null = null) => ({
    address: value,
    name: displayName,
  });
  const message = (
    id: string,
    thread: string,
    input: Partial<MessageData> &
      Pick<MessageData, 'from' | 'to' | 'receivedAt'>,
  ) => ({
    providerMessageId: id,
    data: {
      thread: { externalId: thread, scopeKey: '' },
      rfcMessageId: `${id}@mail.example`,
      inReplyTo: null,
      references: [],
      direction: 'inbound' as const,
      cc: [],
      replyTo: [],
      subject: 'Order confirmation PO-1001',
      text: 'Hello',
      truncated: false,
      sentAt: input.receivedAt,
      labels: ['INBOX'],
      attachments: [],
      // The mailbox provider authenticated the sender, or the mailbox sent the message.
      ...(input.direction === 'outbound'
        ? { providerSent: true }
        : { senderAuthentication: 'aligned' as const }),
      ...input,
    } satisfies MessageData,
  });
  const ops = address('ops@shop.example');
  const anna = address('anna@acme.example', 'Anna');
  const mailbox: ReturnType<typeof message>[] = [
    message('m1', 't1', {
      from: anna,
      to: [ops],
      text: 'We confirm PO-1001 for delivery on 2026-10-20.',
      receivedAt: at(3 * hour),
      attachments: [
        {
          attachment: { externalId: 'a1', scopeKey: '' },
          filename: 'Confirmation PO-1001.pdf',
          mimeType: 'application/pdf',
          size: 2048,
        },
        {
          attachment: { externalId: 'a2', scopeKey: '' },
          filename: 'notes.docx',
          mimeType: 'application/msword',
          size: 100,
        },
        {
          attachment: { externalId: 'a3', scopeKey: '' },
          filename: 'logo.png',
          mimeType: 'image/png',
          size: 10,
        },
      ],
    }),
    message('m2', 't1', {
      direction: 'outbound',
      from: ops,
      to: [anna],
      subject: 'Re: Order confirmation PO-1001',
      text: 'Thank you',
      receivedAt: at(2.5 * hour),
    }),
    message('m3', 't1', {
      from: anna,
      to: [ops],
      subject: 'Re: Order confirmation PO-1001',
      text: 'One more update on PO-1001: two cartons ship later.',
      receivedAt: at(2 * hour),
    }),
    message('m4', 't2', {
      from: address('kim@customer.example', 'Kim'),
      to: [address('orders@shop.example')],
      subject: 'Where is my parcel?',
      text: 'Hi, still waiting.',
      receivedAt: at(5 * hour),
    }),
    message('m5', 't3', {
      from: address('stranger@else.example'),
      to: [ops],
      subject: 'Unrelated',
      text: 'Private',
      receivedAt: at(hour),
    }),
    message('m6', 't4', {
      from: anna,
      to: [ops],
      subject: 'Question about AMB-77',
      text: 'Which one is AMB-77?',
      receivedAt: at(4 * hour),
    }),
  ];

  const reads: { since: string; filter: unknown; cursor: string | null }[] = [];
  let failure: string | null = null;
  const reader: MessageReader = {
    async messages(_context, _connection, input) {
      reads.push({
        since: input.receivedSince,
        filter: input.filter,
        cursor: input.cursor,
      });
      if (failure) return { ok: false, code: failure };
      const matches = mailbox.filter(({ data }) => {
        const domain = (value: string) => value.split('@')[1]!;
        const correspondents =
          data.direction === 'inbound'
            ? [data.from.address]
            : data.to.map((a) => a.address);

        return (
          data.receivedAt >= input.receivedSince &&
          (correspondents.some((a) =>
            input.filter.senderDomains.includes(domain(a)),
          ) ||
            data.to.some((a) =>
              input.filter.recipientAddresses.includes(a.address),
            ))
        );
      });
      const start = Number(input.cursor ?? 0);

      return {
        ok: true,
        items: matches.slice(start, start + 2),
        nextCursor: start + 2 < matches.length ? String(start + 2) : null,
      };
    },
    async thread(_context, _connection, input) {
      return {
        ok: true,
        items: mailbox.filter(
          (m) => m.data.thread.externalId === input.thread.externalId,
        ),
        nextCursor: null,
      };
    },
  };
  const handedOff: Parameters<ProcurementHandoff['record']>[1][] = [];
  const connection: MailboxConnection = {
    id: connectionId,
    label: 'Operations mailbox',
    provider: 'gmail',
    status: 'active',
    version: 1,
    address: 'ops@shop.example',
    canRead: true,
    canSend: true,
    installerId: adminId,
  };
  let messaging: ReturnType<typeof createMessaging>;

  beforeAll(async () => {
    await admin.query(`CREATE DATABASE "${name}"`);
    const url = new URL(databaseUrl!);
    url.pathname = `/${name}`;
    owner = new Pool({ connectionString: url.toString() });
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
    // The API login's messaging and record-reader roles, never the owner's.
    await admin.query(`GRANT luma_desk TO "${name}"`);
    url.username = name;
    url.password = password;
    runtime = new Pool({ connectionString: url.toString(), max: 6 });

    for (const id of [tenant, otherTenant])
      await owner.query(
        "INSERT INTO organizations(data_region,id,name,slug,status,created_at) VALUES('AU',$1,'Shop',$2,'active',now())",
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
    await owner.query(
      'INSERT INTO procurement_suppliers(tenant_id,id,document) VALUES($1,$2,$3)',
      [
        tenant,
        supplierId,
        { tenantId: tenant, id: supplierId, name: 'Acme Supplies' },
      ],
    );
    for (const [id, reference] of [
      [orderId, 'PO-1001'],
      [ambiguous[0], 'AMB-77'],
      [ambiguous[1], 'AMB-77'],
    ] as const)
      await owner.query(
        'INSERT INTO procurement_purchase_orders(tenant_id,id,supplier_id,document,created_at) VALUES($1,$2,$3,$4,now())',
        [
          tenant,
          id,
          supplierId,
          {
            tenantId: tenant,
            id,
            supplierId,
            reference,
            externalReferences: [],
            status: 'open',
          },
        ],
      );
    const client = await owner.connect();
    try {
      // Profiles reference imported observations; the directory reads the email only.
      await client.query("SET session_replication_role='replica'");
      await client.query(
        `INSERT INTO customer_profiles(tenant_id,connection_id,external_id,id,display_name,email,state,contact_shared,
          address_shared,observed_at,observation_id) VALUES($1,$2,'c-1',$3,'Kim','Kim@Customer.example','enabled',true,false,now(),$4)`,
        [tenant, connectionId, customerId, randomUUID()],
      );
    } finally {
      await client.query("SET session_replication_role='origin'");
      client.release();
    }

    const database = createTenantDatabase(runtime);
    messaging = createMessaging(database, {
      audit: createAuditLog,
      refreshContext: async (c) => c,
      resolveContext: async (userId, tenantId) => {
        if (userId !== adminId || tenantId !== tenant)
          throw new Error('unknown');

        return adminContext();
      },
      connections: {
        list: async (c) => (c.tenantId === tenant ? [connection] : []),
      },
      directory: createRecordDirectory(database),
      members: {
        canReadMessages: async (_c, userId) =>
          userId === adminId || userId === memberId,
      },
      reader,
      handoff: {
        async record(_c, input) {
          handedOff.push(input);

          return 'recorded';
        },
      },
    });
  });

  afterAll(async () => {
    await runtime?.end();
    await owner?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.query(`DROP ROLE IF EXISTS "${name}"`);
    await admin.end();
  });

  /** Runs background passes for the workspace like the sync worker. */
  async function drain() {
    for (let pass = 0; pass < 5; pass++) {
      const scopes = (await messaging.sync!.scopes()).filter(
        (scope) => scope.tenantId === tenant,
      );
      if (!scopes.length) return;
      for (const scope of scopes) await messaging.sync!.tick(scope);
    }
  }

  async function threadByProvider(providerThreadId: string) {
    const id = (
      await owner.query<{ id: string }>(
        'SELECT id FROM messaging_threads WHERE tenant_id=$1 AND provider_thread_id=$2',
        [tenant, providerThreadId],
      )
    ).rows[0]?.id;

    return messaging.service.thread(adminContext(), id!);
  }

  it('creates the mailbox for its installer and validates supplier rules', async () => {
    const listed = await messaging.service.mailboxes(adminContext());
    expect(listed.canManage).toBe(true);
    expect(listed.items).toEqual([
      expect.objectContaining({
        connectionId,
        address: 'ops@shop.example',
        state: 'needs_rules',
        settings: {
          backfillDays: 30,
          replyHours: 24,
          approveAll: false,
          paused: false,
        },
      }),
    ]);
    expect(
      (
        await owner.query(
          'SELECT principal_id FROM messaging_mailboxes WHERE connection_id=$1',
          [connectionId],
        )
      ).rows[0].principal_id,
    ).toBe(adminId);
    await expect(
      messaging.service.addRule(adminContext(), connectionId, {
        id: randomUUID(),
        kind: 'sender_domain',
        value: 'acme.example',
        party: { kind: 'supplier', supplierId: randomUUID() },
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      messaging.service.addRule(context(memberId, 'member'), connectionId, {
        id: randomUUID(),
        kind: 'sender_domain',
        value: 'acme.example',
        party: { kind: 'other' },
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    const settings = await messaging.service.updateMailbox(
      adminContext(),
      connectionId,
      {
        backfillDays: 30,
        replyHours: 1,
        approveAll: false,
        paused: false,
        expectedRevision: listed.items[0]!.revision,
      },
    );
    await expect(
      messaging.service.updateMailbox(adminContext(), connectionId, {
        ...settings.settings,
        expectedRevision: listed.items[0]!.revision,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    const ruleId = randomUUID();
    const rule = {
      id: ruleId,
      kind: 'sender_domain' as const,
      value: 'Acme.example',
      party: { kind: 'supplier' as const, supplierId },
    };
    const added = await messaging.service.addRule(
      adminContext(),
      connectionId,
      rule,
    );
    expect(added.state).toBe('syncing');
    expect(added.rules).toEqual([
      expect.objectContaining({
        id: ruleId,
        value: 'acme.example',
        partyLabel: 'Acme Supplies',
        backfilledAt: null,
      }),
    ]);
    // An exact retry is accepted; the same rule under a new ID is refused.
    await messaging.service.addRule(adminContext(), connectionId, rule);
    await expect(
      messaging.service.addRule(adminContext(), connectionId, {
        ...rule,
        id: randomUUID(),
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('reads the backfill window through the rule filter and builds evidenced threads', async () => {
    await drain();
    expect(reads[0]).toMatchObject({
      cursor: null,
      filter: {
        senderDomains: ['acme.example'],
        senderAddresses: [],
        recipientAddresses: [],
        labels: [],
        includeSent: true,
      },
    });
    expect(Date.parse(reads[0]!.since)).toBeLessThan(now - 29 * 24 * hour);
    expect(reads.map((r) => r.cursor)).toEqual([null, '2']);

    const [mailboxView] = (await messaging.service.mailboxes(adminContext()))
      .items;
    expect(mailboxView).toMatchObject({ state: 'current' });
    expect(mailboxView!.coveredUntil).not.toBeNull();
    expect(mailboxView!.rules[0]!.backfilledAt).not.toBeNull();

    const detail = await threadByProvider('t1');
    expect(detail.thread).toMatchObject({
      subject: 'Order confirmation PO-1001',
      messageCount: 3,
      correspondent: anna,
      snippet: 'One more update on PO-1001: two cartons ship later.',
      awaitingReply: true,
      overdue: true,
      attachmentCount: 3,
      status: 'open',
    });
    // The latest inbound message is two hours old and the mailbox replies within an hour.
    expect(detail.thread.replyDueAt).toBe(new Date(now - hour).toISOString());
    expect(
      detail.links
        .map((l) => [l.record.kind, l.record.label, l.method, l.state])
        .sort(),
    ).toEqual([
      ['purchase_order', 'PO-1001', 'reference', 'active'],
      ['supplier', 'Acme Supplies', 'rule', 'active'],
    ]);
    const reference = detail.links.find(
      (l) => l.record.kind === 'purchase_order',
    )!;
    const evidenceMessage = detail.messages.find(
      (m) => m.id === reference.evidence.messageId,
    )!;
    expect(
      evidenceMessage.text!.slice(
        reference.evidence.span!.start,
        reference.evidence.span!.end,
      ),
    ).toBe('PO-1001');
    expect(
      detail.documents
        .map((d) => [d.filename, d.state, d.stateReason !== null])
        .sort(),
    ).toEqual([
      ['Confirmation PO-1001.pdf', 'pending', false],
      ['notes.docx', 'unsupported', true],
    ]);
    expect(detail.messages[0]!.attachments.map((a) => !!a.documentId)).toEqual([
      true,
      true,
      false,
    ]);
    expect(detail.events.filter((e) => e.type === 'received')).toHaveLength(2);
    expect(detail.events.filter((e) => e.type === 'sent')).toHaveLength(1);

    const suggestion = await threadByProvider('t4');
    expect(
      suggestion.links.map((l) => [l.record.kind, l.state]).sort(),
    ).toEqual([
      ['purchase_order', 'suggested'],
      ['purchase_order', 'suggested'],
      ['supplier', 'active'],
    ]);
    expect(suggestion.thread.links).toEqual([
      expect.objectContaining({ kind: 'supplier' }),
    ]);
    expect(
      (
        await owner.query(
          "SELECT count(*)::int AS n FROM messaging_messages WHERE provider_message_id IN ('m4','m5')",
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it('hands inbound supplier messages on a purchase-order thread to procurement once', async () => {
    expect(handedOff.map((h) => [h.purchaseOrderId, h.messageId])).toEqual([
      [orderId, 'm1@mail.example'],
      [orderId, 'm3@mail.example'],
    ]);
    expect(handedOff[0]).toMatchObject({
      from: 'anna@acme.example',
      subject: 'Order confirmation PO-1001',
      body: 'We confirm PO-1001 for delivery on 2026-10-20.',
    });
    const ids = handedOff.map((h) => h.id);
    const detail = await threadByProvider('t1');
    expect(
      detail.events
        .filter((e) => e.type === 'handed_off')
        .map((e) => e.details.outcome),
    ).toEqual(['recorded', 'recorded']);

    // A forced reread returns the same messages; nothing is stored or handed off twice.
    const before = (
      await owner.query(
        'SELECT (SELECT count(*) FROM messaging_messages)::int AS messages,(SELECT count(*) FROM messaging_events)::int AS events,(SELECT count(*) FROM messaging_documents)::int AS documents',
      )
    ).rows[0];
    await owner.query(
      "UPDATE messaging_mailboxes SET cursor=cursor-'coveredUntil'",
    );
    await messaging.service.syncMailbox(adminContext(), connectionId);
    await drain();
    expect(
      (
        await owner.query(
          'SELECT (SELECT count(*) FROM messaging_messages)::int AS messages,(SELECT count(*) FROM messaging_events)::int AS events,(SELECT count(*) FROM messaging_documents)::int AS documents',
        )
      ).rows[0],
    ).toEqual(before);
    expect(handedOff.map((h) => h.id)).toEqual(ids);
    expect(new Set(ids).size).toBe(2);
  });

  it('reads incrementally with an overlap and backfills only a new rule', async () => {
    reads.length = 0;
    await messaging.service.syncMailbox(adminContext(), connectionId);
    await drain();
    const covered = Date.parse(
      (
        await owner.query(
          "SELECT cursor->>'coveredUntil' AS covered FROM messaging_mailboxes WHERE connection_id=$1",
          [connectionId],
        )
      ).rows[0].covered,
    );
    expect(reads).toHaveLength(1);
    expect(Date.parse(reads[0]!.since)).toBeLessThan(covered);

    reads.length = 0;
    await messaging.service.addRule(adminContext(), connectionId, {
      id: randomUUID(),
      kind: 'recipient_address',
      value: 'orders@shop.example',
      party: { kind: 'customer' },
    });
    await drain();
    expect(reads[0]!.filter).toMatchObject({
      senderDomains: [],
      recipientAddresses: ['orders@shop.example'],
    });
    expect(Date.parse(reads[0]!.since)).toBeLessThan(now - 29 * 24 * hour);
    const customer = await threadByProvider('t2');
    expect(
      customer.links.map((l) => [l.record.kind, l.record.id, l.method]),
    ).toEqual([['customer', customerId, 'address']]);
  });

  it('keeps tenant data behind RLS and the reader’s workspace', async () => {
    const outsider = await messaging.service.threads(
      context(adminId, 'admin', otherTenant),
      { view: 'all', limit: 50 },
    );
    expect(outsider.items).toEqual([]);
    expect(
      (await runtime.query('SELECT count(*)::int AS n FROM messaging_threads'))
        .rows[0].n,
    ).toBe(0);
    const id = (await threadByProvider('t1')).thread.id;
    await expect(
      messaging.service.thread(context(adminId, 'admin', otherTenant), id),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('assigns threads idempotently and only to members who can read messages', async () => {
    const thread = (await threadByProvider('t1')).thread;
    const commandId = randomUUID();
    await expect(
      messaging.service.assign(context(memberId, 'member'), thread.id, {
        id: commandId,
        expectedRevision: thread.revision,
        ownerId: memberId,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      messaging.service.assign(adminContext(), thread.id, {
        id: randomUUID(),
        expectedRevision: thread.revision,
        ownerId: randomUUID(),
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    const input = {
      id: commandId,
      expectedRevision: thread.revision,
      ownerId: memberId,
    };
    const assigned = await messaging.service.assign(
      adminContext(),
      thread.id,
      input,
    );
    expect(assigned).toMatchObject({
      ownerId: memberId,
      revision: thread.revision + 1,
    });
    expect(
      await messaging.service.assign(adminContext(), thread.id, input),
    ).toMatchObject({ revision: thread.revision + 1 });
    await expect(
      messaging.service.assign(adminContext(), thread.id, {
        ...input,
        ownerId: adminId,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      messaging.service.setStatus(adminContext(), thread.id, {
        id: randomUUID(),
        expectedRevision: thread.revision,
        status: 'waiting',
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(
      (
        await owner.query(
          'SELECT count(*)::int AS n FROM audit_entries WHERE event_key=$1',
          [`messaging:thread.assigned:${commandId}`],
        )
      ).rows[0].n,
    ).toBe(1);
    const mine = await messaging.service.threads(context(memberId, 'member'), {
      view: 'mine',
      limit: 50,
    });
    expect(mine.items.map((t) => t.id)).toEqual([thread.id]);
    expect(mine.counts).toMatchObject({ mine: 1, overdue: 3 });
  });

  it('filters, sorts and groups threads by structured properties only', async () => {
    const t1 = (await threadByProvider('t1')).thread.id;
    const member = context(memberId, 'member');
    const list = (query: Record<string, unknown>, as = member) =>
      messaging.service.threads(as, { view: 'all', limit: 50, ...query });
    const where = (...conditions: unknown[]) => ({
      match: 'all' as const,
      conditions: conditions as {
        field: string;
        op: string;
        value?: unknown;
      }[],
    });
    const all = (await list({})).items;
    expect(all.length).toBeGreaterThan(1);
    const ids = async (query: Record<string, unknown>, as = member) =>
      (await list(query, as)).items.map((thread) => thread.id).sort();
    const expected = (keep: (thread: (typeof all)[number]) => boolean) =>
      all
        .filter(keep)
        .map((thread) => thread.id)
        .sort();

    expect(
      await ids({
        where: where({
          field: 'owner',
          op: 'any_of',
          value: [{ dynamic: 'me' }],
        }),
      }),
    ).toEqual([t1]);
    expect(
      await ids(
        {
          where: where({
            field: 'owner',
            op: 'any_of',
            value: [{ dynamic: 'me' }],
          }),
        },
        adminContext(),
      ),
    ).toEqual(expected((thread) => thread.ownerId === adminId));
    expect(
      await ids({ where: where({ field: 'owner', op: 'empty' }) }),
    ).toEqual(expected((thread) => thread.ownerId === null));
    for (const value of [true, false])
      expect(
        await ids({
          where: where({ field: 'hasAttachments', op: 'is', value }),
        }),
      ).toEqual(expected((thread) => thread.attachmentCount > 0 === value));
    for (const value of [true, false])
      expect(
        await ids({
          where: where({ field: 'awaitingReply', op: 'is', value }),
        }),
      ).toEqual(expected((thread) => thread.awaitingReply === value));
    expect(
      await ids({
        where: where({ field: 'factsToReview', op: 'is', value: true }),
      }),
    ).toEqual(expected((thread) => thread.factsToReview > 0));
    expect(
      await ids({
        where: where({
          field: 'linkedRecord',
          op: 'any_of',
          value: ['purchase_order'],
        }),
      }),
    ).toEqual(
      expected((thread) =>
        thread.links.some((link) => link.kind === 'purchase_order'),
      ),
    );
    expect(
      await ids({
        where: where({
          field: 'linkedRecord',
          op: 'none_of',
          value: ['purchase_order'],
        }),
      }),
    ).toEqual(
      expected(
        (thread) =>
          !thread.links.some((link) => link.kind === 'purchase_order'),
      ),
    );
    expect(
      await ids({
        where: where({
          field: 'linkedRecord',
          op: 'all_of',
          value: ['purchase_order', 'supplier'],
        }),
      }),
    ).toContain(t1);
    expect(
      await ids({
        where: where({
          field: 'mailbox',
          op: 'none_of',
          value: [connectionId],
        }),
      }),
    ).toEqual([]);
    const from = new Date(now - 2 * hour).toISOString();
    const to = new Date(now).toISOString();
    expect(
      await ids({
        where: where({ field: 'due', op: 'between', value: { from, to } }),
      }),
    ).toEqual(
      expected(
        (thread) =>
          thread.replyDueAt !== null &&
          thread.replyDueAt >= from &&
          thread.replyDueAt <= to,
      ),
    );
    expect(await ids({ where: where({ field: 'due', op: 'empty' }) })).toEqual(
      expected((thread) => thread.replyDueAt === null),
    );
    expect(
      await ids({
        where: {
          match: 'any',
          conditions: [
            { field: 'owner', op: 'not_empty' },
            { field: 'hasAttachments', op: 'is', value: false },
          ],
        },
      }),
    ).toEqual(
      expected(
        (thread) => thread.ownerId !== null || thread.attachmentCount === 0,
      ),
    );
    // Message text is never a condition, and conditions never change the view counts.
    await expect(
      list({ where: where({ field: 'subject', op: 'contains', value: 'PO' }) }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(
      (await list({ where: where({ field: 'owner', op: 'empty' }) })).counts,
    ).toEqual((await list({})).counts);

    // Newest activity first by default; deadlines put threads without one last both ways.
    const order = async (query: Record<string, unknown>) =>
      (await list(query)).items;
    const times = (items: typeof all, key: 'lastMessageAt' | 'replyDueAt') =>
      items.map((thread) => thread[key]);
    const newest = await order({});
    expect(times(newest, 'lastMessageAt')).toEqual(
      [...times(newest, 'lastMessageAt')].sort().reverse(),
    );
    const oldest = await order({ direction: 'asc' });
    expect(oldest.map((thread) => thread.id)).toEqual(
      newest.map((thread) => thread.id).reverse(),
    );
    for (const direction of ['asc', 'desc'] as const) {
      const due = times(await order({ sort: 'due', direction }), 'replyDueAt');
      const set = due.filter((at): at is string => at !== null);
      expect(due).toEqual([
        ...[...set].sort((a, b) =>
          direction === 'asc' ? a.localeCompare(b) : b.localeCompare(a),
        ),
        ...due.filter((at) => at === null),
      ]);
    }

    const owners = await list({ group: { field: 'owner' } });
    expect(owners.groups?.at(-1)?.key ?? null).toBe(
      all.some((thread) => thread.ownerId === null) ? null : memberId,
    );
    expect(
      owners.groups?.find((group) => group.key === memberId),
    ).toMatchObject({ count: 1, itemIds: [t1] });
    const mailboxes = await list({
      group: { field: 'mailbox' },
      groupLimit: 1,
    });
    expect(mailboxes.groups).toEqual([
      expect.objectContaining({
        key: connectionId,
        count: all.length,
        itemIds: [newest[0]!.id],
      }),
    ]);
    expect(mailboxes.items.map((thread) => thread.id)).toEqual([newest[0]!.id]);
    const rest = await list({
      group: { field: 'mailbox' },
      groupKey: connectionId,
      cursor: mailboxes.groups![0]!.nextCursor!,
    });
    expect(rest.items.map((thread) => thread.id)).toEqual(
      newest.slice(1).map((thread) => thread.id),
    );
    expect(rest.groups?.[0]).toMatchObject({
      count: all.length,
      nextCursor: null,
    });
    expect(
      (await list({ group: { field: 'status' } })).groups?.map(
        (group) => group.key,
      ),
    ).toEqual(
      ['open', 'waiting', 'closed'].filter((status) =>
        all.some((thread) => thread.status === status),
      ),
    );

    // Page links continue only the same query of the same reader.
    const first = await list({ limit: 1 });
    expect(
      (await list({ limit: 1, cursor: first.nextCursor! })).items.map(
        (thread) => thread.id,
      ),
    ).toEqual([newest[1]!.id]);
    for (const [query, as] of [
      [{ limit: 1, sort: 'due' }, member],
      [{ limit: 1, where: where({ field: 'owner', op: 'empty' }) }, member],
      [{ limit: 1, q: 'order' }, member],
      [{ limit: 1 }, adminContext()],
    ] as const)
      await expect(
        list({ ...query, cursor: first.nextCursor! }, as),
      ).rejects.toMatchObject({ statusCode: 422 });
    expect(
      await ids(
        { where: where({ field: 'owner', op: 'empty' }) },
        context(adminId, 'admin', otherTenant),
      ),
    ).toEqual([]);
  });

  it('records notes, deadlines, status and links on the timeline, and reopens on new mail', async () => {
    let detail = await threadByProvider('t1');
    const id = detail.thread.id;
    detail = await messaging.service.addNote(adminContext(), id, {
      id: randomUUID(),
      body: 'Call Anna if the cartons slip again.',
    });
    expect(detail.notes.map((n) => n.body)).toEqual([
      'Call Anna if the cartons slip again.',
    ]);
    const due = new Date(now + 48 * hour).toISOString();
    let summary = await messaging.service.setDeadline(adminContext(), id, {
      id: randomUUID(),
      expectedRevision: detail.thread.revision,
      replyDueAt: due,
    });
    expect(summary).toMatchObject({ replyDueAt: due, overdue: false });
    summary = await messaging.service.setStatus(adminContext(), id, {
      id: randomUUID(),
      expectedRevision: summary.revision,
      status: 'closed',
    });
    expect(summary.status).toBe('closed');

    // Removing the purchase-order link keeps it removed when the reference appears again.
    const link = detail.links.find((l) => l.record.kind === 'purchase_order')!;
    detail = await messaging.service.unlink(
      adminContext(),
      id,
      link.id,
      randomUUID(),
    );
    expect(detail.links.map((l) => l.record.kind)).toEqual(['supplier']);
    mailbox.push(
      message('m7', 't1', {
        from: anna,
        to: [ops],
        subject: 'Re: Order confirmation PO-1001',
        text: 'Final word on PO-1001.',
        receivedAt: new Date().toISOString(),
      }),
    );
    expect(await messaging.service.refreshThread(adminContext(), id)).toEqual({
      inserted: 1,
      complete: true,
    });
    detail = await messaging.service.thread(adminContext(), id);
    expect(detail.thread.status).toBe('open');
    expect(detail.links.map((l) => l.record.kind)).toEqual(['supplier']);
    expect(handedOff).toHaveLength(2);
    expect(detail.events.map((e) => e.type)).toEqual(
      expect.arrayContaining([
        'note_added',
        'deadline_set',
        'status_changed',
        'unlinked',
      ]),
    );

    // Confirming a suggestion activates that link only.
    const suggestion = await threadByProvider('t4');
    const candidate = suggestion.links.find((l) => l.state === 'suggested')!;
    const confirmed = await messaging.service.link(
      adminContext(),
      suggestion.thread.id,
      {
        id: randomUUID(),
        kind: 'purchase_order',
        recordId: candidate.record.id,
      },
    );
    expect(confirmed.links.find((l) => l.id === candidate.id)?.state).toBe(
      'active',
    );
    expect(
      (
        await messaging.service.recordThreads(
          adminContext(),
          'purchase_order',
          candidate.record.id,
        )
      ).items.map((t) => t.id),
    ).toEqual([suggestion.thread.id]);
    await expect(
      messaging.service.link(adminContext(), suggestion.thread.id, {
        id: randomUUID(),
        kind: 'order',
        recordId: randomUUID(),
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('removes message text on request and lists due replies for Needs you', async () => {
    const detail = await threadByProvider('t4');
    const draft = await messaging.replies.draft(
      adminContext(),
      detail.thread.id,
      { id: randomUUID() },
    );
    const removed = await messaging.service.removeMessageText(
      adminContext(),
      detail.thread.id,
      detail.messages[0]!.id,
      randomUUID(),
    );
    expect(removed.messages[0]).toMatchObject({ text: null });
    expect(removed.thread.snippet).toBe('');
    expect(removed.outbound.find((item) => item.id === draft.id)).toMatchObject(
      { text: '', state: 'withheld', canRequest: false },
    );
    expect(removed.messages[0]!.purgedAt).not.toBeNull();
    const due = await messaging.service.dueReplies(adminContext());
    expect(due.map((d) => d.threadId)).toContain(detail.thread.id);
    // Threads assigned to someone else are theirs.
    expect(due.map((d) => d.subject)).not.toContain(
      'Order confirmation PO-1001',
    );
  });

  it('blocks on rejected access until someone reads the mailbox again', async () => {
    failure = 'authentication';
    await messaging.service.syncMailbox(adminContext(), connectionId);
    await drain();
    expect(
      (await messaging.service.mailboxes(adminContext())).items[0],
    ).toMatchObject({
      state: 'blocked',
      stateReason: expect.stringContaining('Reconnect'),
    });
    failure = null;
    await messaging.service.syncMailbox(adminContext(), connectionId);
    await drain();
    expect(
      (await messaging.service.mailboxes(adminContext())).items[0]!.state,
    ).toBe('current');
  });

  it('removes text to and from a customer erased by Shopify', async () => {
    await owner.query(
      "INSERT INTO shopify_installation_bindings(tenant_id,app,shop,connection_id) VALUES($1,'shopify','shop.myshopify.com',$2)",
      [tenant, connectionId],
    );
    const before = await threadByProvider('t2');
    const draft = await messaging.replies.draft(
      adminContext(),
      before.thread.id,
      { id: randomUUID() },
    );
    await owner.query(
      "UPDATE messaging_messages SET retain_until=now()-interval '1 day' WHERE tenant_id=$1 AND thread_id=$2",
      [tenant, before.thread.id],
    );
    await runtime.query('SELECT purge_expired_messaging(200)');
    expect(
      (await threadByProvider('t2')).outbound.find(
        (item) => item.id === draft.id,
      )?.text,
    ).toBe('');
    // Erasure repairs a derived copy even when its source was already retention-purged.
    await owner.query(
      `UPDATE messaging_threads SET document=jsonb_set(document,'{snippet}','"legacy copy"'::jsonb) WHERE tenant_id=$1 AND id=$2`,
      [tenant, before.thread.id],
    );
    await owner.query(
      "SELECT erase_shopify_customer_data('shopify','shop.myshopify.com',ARRAY['c-1'])",
    );
    const customer = await threadByProvider('t2');
    expect(customer.messages[0]).toMatchObject({ text: null });
    expect(customer.thread.snippet).toBe('');
    expect(customer.links).toEqual([]);
    await owner.query(
      "SELECT erase_shopify_customer_data('shopify','shop.myshopify.com',ARRAY['c-1'])",
    );
    expect((await threadByProvider('t2')).thread.snippet).toBe('');
    expect((await threadByProvider('t1')).messages[0]!.text).not.toBeNull();
  });
  it('keeps truncated supplier messages visible without handing incomplete commitments to procurement', async () => {
    const before = handedOff.length;
    mailbox.push(
      message('m-truncated', 't-truncated', {
        from: anna,
        to: [ops],
        text: 'Confirmed 10 units. Later text was cut.',
        truncated: true,
        receivedAt: new Date().toISOString(),
      }),
    );
    await messaging.service.syncMailbox(adminContext(), connectionId);
    await drain();
    const detail = await threadByProvider('t-truncated');
    expect(detail.messages[0]).toMatchObject({ truncated: true });
    expect(
      detail.events.find((event) => event.type === 'handed_off')?.details
        .outcome,
    ).toBe('truncated');
    expect(handedOff).toHaveLength(before);
  });

  it('keeps a forged message from suppressing the genuine one or linking on its sender', async () => {
    const before = handedOff.length;
    const shared = `confirm-${randomUUID()}@acme.example`;
    mailbox.push(
      message('m-forged', 't-shared', {
        from: anna,
        to: [ops],
        subject: 'Delivery for PO-1001',
        text: 'PO-1001 ships in December.',
        rfcMessageId: shared,
        senderAuthentication: 'unaligned',
        receivedAt: new Date().toISOString(),
      }),
    );
    await messaging.service.syncMailbox(adminContext(), connectionId);
    await drain();
    let detail = await threadByProvider('t-shared');
    expect(detail.messages.map((m) => m.senderAuthentication)).toEqual([
      'unaligned',
    ]);
    // The From address is only a claim: the supplier link waits for a person.
    expect(
      detail.links
        .map((l) => [l.record.kind, l.state, l.evidence.senderUnverified])
        .sort(),
    ).toEqual([
      ['purchase_order', 'active', false],
      ['supplier', 'suggested', true],
    ]);
    expect(handedOff.slice(before)).toEqual([
      expect.objectContaining({ messageId: shared, senderVerified: false }),
    ]);

    // The genuine message with the same Message-ID is stored and handed off on its own.
    mailbox.push(
      message('m-genuine', 't-shared', {
        from: anna,
        to: [ops],
        subject: 'Re: Delivery for PO-1001',
        text: 'PO-1001 ships on time.',
        rfcMessageId: shared,
        receivedAt: new Date().toISOString(),
      }),
    );
    await messaging.service.syncMailbox(adminContext(), connectionId);
    await drain();
    detail = await threadByProvider('t-shared');
    expect(
      detail.messages.map((m) => [m.text, m.senderAuthentication]),
    ).toEqual([
      ['PO-1001 ships in December.', 'unaligned'],
      ['PO-1001 ships on time.', 'aligned'],
    ]);
    expect(
      detail.links
        .map((l) => [l.record.kind, l.state, l.evidence.senderUnverified])
        .sort(),
    ).toEqual([
      ['purchase_order', 'active', false],
      ['supplier', 'active', false],
    ]);
    const handed = handedOff.slice(before);
    expect(handed.map((h) => [h.body, h.senderVerified])).toEqual([
      ['PO-1001 ships in December.', false],
      ['PO-1001 ships on time.', true],
    ]);
    expect(new Set(handed.map((h) => h.id)).size).toBe(2);
  });
});
