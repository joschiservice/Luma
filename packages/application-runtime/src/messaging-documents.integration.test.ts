import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

import { createAuditLog } from '@luma/audit/composition';
import type { TenantContext } from '@luma/identity';
import {
  builtInMembership,
  makeTenantContext,
} from '@luma/identity/composition';
import type {
  AttachmentReader,
  MailboxConnection,
  MessageData,
  MessageReader,
} from '@luma/messaging';
import { createMessaging } from '@luma/messaging/composition';
import type { ModelGateway } from '@luma/platform';
import { createTenantDatabase } from '@luma/platform/composition';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createRecordDirectory } from './composition/messaging.js';
import { createDocumentDirectory } from './composition/messaging-documents.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

const hour = 3_600_000;

/** A one-page PDF with a text layer, as the simulator builds them. */
function textPdf(lines: string[]) {
  const stream = [
    'BT',
    '/F1 11 Tf',
    '14 TL',
    '56 786 Td',
    ...lines.map((line) => `(${line}) Tj T*`),
    'ET',
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join(
      '',
    )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

const csv = (rows: string[][]) =>
  Buffer.from(rows.map((row) => row.join(';')).join('\r\n'), 'utf8');

const header = [
  'Bestellung',
  'Artikelnummer',
  'Bezeichnung',
  'Menge',
  'Liefertermin',
];

describe.skipIf(!databaseUrl)('documents on PostgreSQL', () => {
  const name = `messaging_documents_${randomUUID().replaceAll('-', '')}`;
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

  const ops = { address: 'ops@shop.example', name: null };
  const anna = { address: 'anna@acme.example', name: 'Anna' };
  const content = new Map<string, Buffer>();
  const pdf = textPdf([
    'Auftragsbestaetigung',
    'Ihre Bestellung: AMB-77',
    'Liefertermin: 20.10.2026',
  ]);
  const planV1 = csv([
    header,
    ['PO-1001', 'SKU-1', 'Widget', '6', '20.10.2026'],
    ['PO-1001', 'SKU-2', 'Gadget', '5', '20.10.2026'],
    ['PO-1001', 'SKU-3', 'Gizmo', '1', '20.10.2026'],
  ]);
  const planV2 = csv([
    header,
    ['PO-1001', 'SKU-1', 'Widget', '6', '20.10.2026'],
    ['PO-1001', 'SKU-2', 'Gadget', '3', '27.10.2026'],
  ]);

  const attachment = (
    id: string,
    message: string,
    filename: string,
    bytes: Buffer,
    mimeType: string,
  ) => {
    content.set(id, bytes);

    return {
      attachment: { externalId: id, scopeKey: message },
      filename,
      mimeType,
      size: bytes.length,
    };
  };
  const message = (
    id: string,
    thread: string,
    receivedAt: string,
    attachments: MessageData['attachments'],
  ) => ({
    providerMessageId: id,
    data: {
      thread: { externalId: thread, scopeKey: '' },
      rfcMessageId: `${id}@mail.example`,
      inReplyTo: null,
      references: [],
      direction: 'inbound' as const,
      from: anna,
      to: [ops],
      cc: [],
      replyTo: [],
      subject: 'Lieferplan PO-1001',
      text: 'Please find attached.',
      truncated: false,
      sentAt: receivedAt,
      receivedAt,
      labels: ['INBOX'],
      attachments,
    } satisfies MessageData,
  });
  const mailbox = [
    message('m1', 't1', at(3 * hour), [
      attachment('a1', 'm1', 'Lieferplan PO-1001.csv', planV1, 'text/csv'),
      attachment('a2', 'm1', 'AB-AMB-77.pdf', pdf, 'application/pdf'),
      attachment(
        'a3',
        'm1',
        'broken.xlsx',
        Buffer.from('PK broken'),
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ),
      attachment('a4', 'm1', 'notes.txt', Buffer.from('PO-1001'), 'text/plain'),
    ]),
  ];

  const reader: MessageReader = {
    async messages(_context, _connection, input) {
      return {
        ok: true,
        items: mailbox.filter((m) => m.data.receivedAt >= input.receivedSince),
        nextCursor: null,
      };
    },
    async thread() {
      return { ok: true, items: [], nextCursor: null };
    },
  };
  const reads: { tenant: string; attachment: string }[] = [];
  let unavailable = new Set<string>(['a4']);
  const attachments: AttachmentReader = {
    async read(c, _connection, input) {
      reads.push({
        tenant: c.tenantId,
        attachment: input.attachment.externalId,
      });
      if (unavailable.has(input.attachment.externalId))
        return { ok: false, code: 'unavailable' };
      const bytes = content.get(input.attachment.externalId);
      if (!bytes || input.message.externalId !== input.attachment.scopeKey)
        return { ok: false, code: 'not_found' };

      return {
        ok: true,
        bytes: new Uint8Array(bytes),
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    },
  };
  // The model answers for the PDF only; one quote is not in the document.
  const prompts: string[] = [];
  const gateway: ModelGateway = {
    async generate(_trace, request) {
      prompts.push(
        `${request.profile}:${request.dataPolicy.classification}:${request.dataPolicy.region}:${request.dataPolicy.zeroDataRetention}`,
      );
      const empty = {
        name: null,
        email: null,
        text: null,
        sku: null,
        description: null,
        quantity: null,
        unit: null,
        unitPrice: null,
        currency: null,
        date: null,
        amount: null,
        sheet: null,
        row: null,
        column: null,
      };
      const isPdf = JSON.stringify(request.messages).includes('AB-AMB-77.pdf');
      const output = request.output!.parse({
        facts: isPdf
          ? [
              {
                ...empty,
                kind: 'reference',
                role: 'purchase_order',
                text: 'AMB-77',
                quote: 'AMB-77',
                page: 1,
                confident: true,
              },
              {
                ...empty,
                kind: 'date',
                role: 'delivery',
                date: '2026-10-20',
                quote: 'Liefertermin: 20.10.2026',
                page: 1,
                confident: true,
              },
              {
                ...empty,
                kind: 'reference',
                role: 'invoice',
                text: 'R-1',
                quote: 'Rechnung R-1',
                page: 1,
                confident: true,
              },
            ]
          : [],
      });

      return {
        output,
        toolCalls: [],
        metadata: {
          adapter: 'bedrock',
          model: 'test-model',
          latencyMs: 1,
          inputTokens: 1,
          outputTokens: 1,
          costUsd: null,
        },
      };
    },
  };
  const connection: MailboxConnection = {
    id: connectionId,
    label: 'Operations mailbox',
    provider: 'gmail',
    status: 'active',
    version: 1,
    address: 'ops@shop.example',
    canRead: true,
    canSend: false,
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
      // Catalog rows reference imported snapshots; matching reads the code only.
      await client.query("SET session_replication_role='replica'");
      await client.query(
        `INSERT INTO inventory_product_skus(tenant_id,product_id,connection_id,sku_id,code,snapshot_id,product_status,
          unit,observed_at) VALUES($1,$2,$3,$4,'SKU-1',$5,'active','piece',now())`,
        [tenant, randomUUID(), connectionId, randomUUID(), randomUUID()],
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
      documents: {
        attachments,
        directory: createDocumentDirectory(database),
        extraction: { gateway, available: true, reason: null },
      },
    });
    await messaging.service.mailboxes(adminContext());
    await messaging.service.addRule(adminContext(), connectionId, {
      id: randomUUID(),
      kind: 'sender_domain',
      value: 'acme.example',
      party: { kind: 'supplier', supplierId },
    });
  });

  afterAll(async () => {
    // Dropping the database terminates connections a closing pool may still hold.
    runtime?.on('error', () => {});
    owner?.on('error', () => {});
    await runtime?.end();
    await owner?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.query(`DROP ROLE IF EXISTS "${name}"`);
    await admin.end();
  });

  /** Runs background passes for the workspace like the sync worker. */
  async function drain() {
    for (let pass = 0; pass < 8; pass++) {
      const scopes = (await messaging.sync!.scopes()).filter(
        (scope) => scope.tenantId === tenant,
      );
      if (!scopes.length) return;
      for (const scope of scopes) await messaging.sync!.tick(scope);
    }
  }

  async function thread(providerThreadId: string) {
    const id = (
      await owner.query<{ id: string }>(
        'SELECT id FROM messaging_threads WHERE tenant_id=$1 AND provider_thread_id=$2',
        [tenant, providerThreadId],
      )
    ).rows[0]!.id;

    return messaging.service.thread(adminContext(), id);
  }

  const documentNamed = async (providerThreadId: string, filename: string) =>
    (await thread(providerThreadId)).documents.find(
      (d) => d.filename === filename,
    )!;

  it('reads documents into representations and proposes located facts', async () => {
    await drain();
    const detail = await thread('t1');
    expect(
      Object.fromEntries(
        detail.documents.map((d) => [d.filename, [d.state, d.stateReason]]),
      ),
    ).toEqual({
      'Lieferplan PO-1001.csv': ['ready', null],
      'AB-AMB-77.pdf': ['ready', null],
      'broken.xlsx': [
        'unreadable',
        'The file is damaged or not in the format its name says.',
      ],
      'notes.txt': [
        'reading',
        'Luma could not get the file from the mailbox. Read it again to retry.',
      ],
    });
    expect(
      prompts.every((p) => p === 'document-extraction:sensitive:AU:true'),
    ).toBe(true);

    const plan = await messaging.documents.document(
      adminContext(),
      (await documentNamed('t1', 'Lieferplan PO-1001.csv')).id,
    );
    expect(plan.representation).toMatchObject({
      kind: 'sheets',
      sheets: [{ name: 'Lieferplan PO-1001', rows: expect.any(Array) }],
    });
    const lines = plan.facts.filter((f) => f.value.kind === 'line');
    expect(
      lines.map((f) => [f.value, f.match.state, f.origin, f.status]),
    ).toEqual([
      [
        expect.objectContaining({ sku: 'SKU-1', quantity: '6' }),
        'matched',
        'table',
        'proposed',
      ],
      [
        expect.objectContaining({ sku: 'SKU-2', quantity: '5' }),
        'unmatched',
        'table',
        'proposed',
      ],
      [
        expect.objectContaining({ sku: 'SKU-3', quantity: '1' }),
        'unmatched',
        'table',
        'proposed',
      ],
    ]);
    expect(lines[0]!.locator).toEqual({
      kind: 'cells',
      sheet: 'Lieferplan PO-1001',
      row: 2,
      rowEnd: 2,
      column: 2,
      columnEnd: 4,
    });
    expect(lines[0]!.quote).toBe('SKU-1\tWidget\t6');
    expect(plan.facts.find((f) => f.value.kind === 'reference')!.match).toEqual(
      {
        state: 'matched',
        record: { kind: 'purchase_order', id: orderId, label: 'PO-1001' },
        candidates: [],
      },
    );
    expect(plan.document).toMatchObject({ version: 1, previousId: null });
    expect(detail.thread.factsToReview).toBe(
      detail.documents.reduce((n, d) => n + d.factsToReview, 0),
    );
    expect(detail.thread.factsToReview).toBeGreaterThan(0);

    const confirmation = await messaging.documents.document(
      adminContext(),
      (await documentNamed('t1', 'AB-AMB-77.pdf')).id,
    );
    expect(confirmation.representation).toEqual({
      kind: 'text',
      pages: [
        'Auftragsbestaetigung\nIhre Bestellung: AMB-77\nLiefertermin: 20.10.2026',
      ],
    });
    expect(confirmation.extraction).toEqual({
      available: true,
      reason: expect.stringContaining('1 proposed fact was left out'),
    });
    expect(
      confirmation.facts.map((f) => [
        f.value.kind,
        f.quote,
        f.locator,
        f.status,
      ]),
    ).toEqual([
      [
        'reference',
        'AMB-77',
        { kind: 'text', page: null, start: 38, end: 44 },
        'needs_correction',
      ],
      [
        'date',
        'Liefertermin: 20.10.2026',
        { kind: 'text', page: null, start: 45, end: 69 },
        'proposed',
      ],
    ]);
    expect(confirmation.facts[0]!.match).toMatchObject({
      state: 'ambiguous',
      candidates: [
        expect.objectContaining({ kind: 'purchase_order' }),
        expect.objectContaining({ kind: 'purchase_order' }),
      ],
    });
  });

  it('confirms an ambiguous fact only with a correction naming the record', async () => {
    const pdfDocument = await documentNamed('t1', 'AB-AMB-77.pdf');
    const detail = await messaging.documents.document(
      adminContext(),
      pdfDocument.id,
    );
    const fact = detail.facts[0]!;
    await expect(
      messaging.documents.reviewFact(adminContext(), fact.id, {
        id: randomUUID(),
        outcome: 'confirm',
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      messaging.documents.reviewFact(adminContext(), fact.id, {
        id: randomUUID(),
        outcome: 'correct',
        correction: { value: fact.value, record: null },
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      messaging.documents.reviewFact(context(memberId, 'member'), fact.id, {
        id: randomUUID(),
        outcome: 'reject',
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      messaging.documents.reviewFact(adminContext(), fact.id, {
        id: randomUUID(),
        outcome: 'correct',
        correction: {
          value: fact.value,
          record: { kind: 'order', id: randomUUID() },
        },
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
    const commandId = randomUUID();
    const input = {
      id: commandId,
      outcome: 'correct' as const,
      correction: {
        value: fact.value,
        record: { kind: 'purchase_order' as const, id: ambiguous[1]! },
      },
    };
    const corrected = await messaging.documents.reviewFact(
      adminContext(),
      fact.id,
      input,
    );
    expect(corrected).toMatchObject({
      status: 'confirmed',
      match: {
        state: 'matched',
        record: { kind: 'purchase_order', id: ambiguous[1] },
      },
      review: { outcome: 'corrected', by: adminId, original: fact.value },
    });
    // An exact retry returns the same fact; the same ID with another body conflicts.
    expect(
      await messaging.documents.reviewFact(adminContext(), fact.id, input),
    ).toEqual(corrected);
    await expect(
      messaging.documents.reviewFact(adminContext(), fact.id, {
        id: commandId,
        outcome: 'reject',
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(
      (await thread('t1')).events.filter((e) => e.type === 'fact_reviewed'),
    ).toEqual([
      expect.objectContaining({
        actor: { kind: 'user', id: adminId },
        details: {
          documentId: pdfDocument.id,
          factId: fact.id,
          kind: 'reference',
          outcome: 'corrected',
        },
      }),
    ]);
    expect(
      (
        await owner.query(
          'SELECT count(*)::int AS n FROM audit_entries WHERE event_key=$1',
          [`messaging:fact.reviewed:${commandId}`],
        )
      ).rows[0].n,
    ).toBe(1);
  });

  it('adds facts by hand only where the document has them', async () => {
    const plan = await documentNamed('t1', 'Lieferplan PO-1001.csv');
    const value = {
      kind: 'reference' as const,
      role: 'other' as const,
      text: 'Gizmo',
    };
    await expect(
      messaging.documents.addFact(adminContext(), plan.id, {
        id: randomUUID(),
        value,
        locator: {
          kind: 'cells',
          sheet: 'Lieferplan PO-1001',
          row: 9,
          rowEnd: 9,
          column: 1,
          columnEnd: 1,
        },
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
    await expect(
      messaging.documents.addFact(context(memberId, 'member'), plan.id, {
        id: randomUUID(),
        value,
        locator: {
          kind: 'cells',
          sheet: 'Lieferplan PO-1001',
          row: 4,
          rowEnd: 4,
          column: 3,
          columnEnd: 3,
        },
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    const id = randomUUID();
    const added = await messaging.documents.addFact(adminContext(), plan.id, {
      id,
      value,
      locator: {
        kind: 'cells',
        sheet: 'Lieferplan PO-1001',
        row: 4,
        rowEnd: 4,
        column: 3,
        columnEnd: 3,
      },
    });
    expect(added.facts.find((f) => f.id === id)).toMatchObject({
      quote: 'Gizmo',
      origin: 'manual',
      confidence: 'high',
      status: 'proposed',
      match: { state: 'not_applicable' },
    });
    // Confirm the first line, so the next version carries the confirmation.
    const line = added.facts.find(
      (f) => f.value.kind === 'line' && f.value.sku === 'SKU-1',
    )!;
    await messaging.documents.reviewFact(adminContext(), line.id, {
      id: randomUUID(),
      outcome: 'confirm',
    });
  });

  it('treats repeated content as a duplicate and an amended file as a new version', async () => {
    // Newer than the mailbox's coverage, so the next incremental read finds them.
    mailbox.push(
      message('m2', 't1', new Date().toISOString(), [
        attachment('b1', 'm2', 'Lieferplan PO-1001 v2.csv', planV2, 'text/csv'),
        attachment('b2', 'm2', 'AB-AMB-77 (1).pdf', pdf, 'application/pdf'),
      ]),
      message('m3', 't5', new Date().toISOString(), [
        attachment('c1', 'm3', 'Kopie.csv', planV1, 'text/csv'),
      ]),
    );
    await messaging.service.syncMailbox(adminContext(), connectionId);
    // A queued read may not yet be due on PostgreSQL's clock, even after the caller requested sync.
    await owner.query(
      "UPDATE messaging_mailboxes SET hint_at=clock_timestamp()+interval '250 milliseconds' WHERE tenant_id=$1 AND connection_id=$2",
      [tenant, connectionId],
    );
    await vi.waitFor(
      async () => {
        await drain();
        const detail = await thread('t1');
        expect(detail.messages.map((item) => item.source.messageId)).toContain(
          'm2',
        );
        expect(
          detail.documents.map((document) => [
            document.filename,
            document.state,
          ]),
        ).toEqual(
          expect.arrayContaining([
            ['AB-AMB-77 (1).pdf', 'duplicate'],
            ['Lieferplan PO-1001 v2.csv', 'ready'],
          ]),
        );
        expect((await documentNamed('t5', 'Kopie.csv')).state).toBe(
          'duplicate',
        );
      },
      { interval: 25, timeout: 5000 },
    );
    const v1 = await documentNamed('t1', 'Lieferplan PO-1001.csv');
    const original = await documentNamed('t1', 'AB-AMB-77.pdf');
    const copy = await documentNamed('t1', 'AB-AMB-77 (1).pdf');
    expect(copy).toMatchObject({
      state: 'duplicate',
      duplicateOf: original.id,
      factsToReview: 0,
    });
    expect(await documentNamed('t5', 'Kopie.csv')).toMatchObject({
      state: 'duplicate',
      duplicateOf: v1.id,
    });
    const duplicate = await messaging.documents.document(
      adminContext(),
      copy.id,
    );
    expect(duplicate).toMatchObject({ facts: [], canReview: false });

    const v2 = await documentNamed('t1', 'Lieferplan PO-1001 v2.csv');
    expect(v2).toMatchObject({ state: 'ready', version: 2, previousId: v1.id });
    const diff = await messaging.documents.document(adminContext(), v2.id);
    const byKey = (facts: typeof diff.facts) =>
      facts.map((f) => [
        f.value.kind === 'line'
          ? f.value.sku
          : f.value.kind === 'date'
            ? f.value.date
            : f.value.kind,
        f.change,
        f.status,
      ]);
    // Facts are in document order; the confirmed line keeps its confirmation.
    expect(byKey(diff.facts)).toEqual([
      ['reference', 'unchanged', 'proposed'],
      ['SKU-1', 'unchanged', 'confirmed'],
      ['2026-10-20', 'unchanged', 'proposed'],
      ['SKU-2', 'changed', 'proposed'],
      ['2026-10-27', 'changed', 'proposed'],
    ]);
    expect(byKey(diff.removedFacts)).toEqual([
      ['SKU-3', null, 'proposed'],
      ['reference', null, 'proposed'],
      ['2026-10-20', null, 'proposed'],
    ]);
  });

  it('marks reads that keep failing as failed and reads them again on request', async () => {
    await owner.query(
      "UPDATE messaging_documents SET attempts=4,updated_at=now()-interval '2 hours' WHERE tenant_id=$1 AND provider_attachment_id='a4'",
      [tenant],
    );
    await messaging.sync!.tick({ tenantId: tenant, principalId: adminId });
    const failed = await documentNamed('t1', 'notes.txt');
    expect(failed).toMatchObject({ state: 'failed' });
    await expect(
      messaging.documents.readDocument(
        adminContext(),
        (await documentNamed('t1', 'broken.xlsx')).id,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    unavailable = new Set();
    const again = await messaging.documents.readDocument(
      adminContext(),
      failed.id,
      randomUUID(),
    );
    expect(again.document).toMatchObject({
      state: 'pending',
      stateReason: null,
    });
    await drain();
    expect(await documentNamed('t1', 'notes.txt')).toMatchObject({
      state: 'ready',
    });
  });

  it('keeps documents and facts inside their workspace', async () => {
    const plan = await documentNamed('t1', 'Lieferplan PO-1001.csv');
    const other = context(randomUUID(), 'admin', otherTenant);
    await expect(
      messaging.documents.document(other, plan.id),
    ).rejects.toMatchObject({ statusCode: 404 });
    const detail = await messaging.documents.document(adminContext(), plan.id);
    await expect(
      messaging.documents.reviewFact(other, detail.facts[0]!.id, {
        id: randomUUID(),
        outcome: 'reject',
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    const visible = await runtime.connect();
    try {
      await visible.query('BEGIN');
      await visible.query("SELECT set_config('app.tenant_id',$1,true)", [
        otherTenant,
      ]);
      expect(
        (await visible.query('SELECT count(*)::int AS n FROM messaging_facts'))
          .rows[0].n,
      ).toBe(0);
      expect(
        (
          await visible.query(
            'SELECT count(*)::int AS n FROM messaging_documents',
          )
        ).rows[0].n,
      ).toBe(0);
      await visible.query('ROLLBACK');
    } finally {
      visible.release();
    }
    expect(reads.every((read) => read.tenant === tenant)).toBe(true);
  });

  it('removes content, representation and quotes with the message text', async () => {
    const detail = await thread('t1');
    const plan = detail.documents.find(
      (d) => d.filename === 'Lieferplan PO-1001.csv',
    )!;
    await messaging.service.removeMessageText(
      adminContext(),
      detail.thread.id,
      plan.messageId,
      randomUUID(),
    );
    const removed = await messaging.documents.document(adminContext(), plan.id);
    expect(removed.representation).toBeNull();
    expect(removed.facts.length).toBeGreaterThan(0);
    expect(removed.facts.every((f) => f.quote === '')).toBe(true);
    expect(removed.facts.map((f) => f.value)).toContainEqual(
      expect.objectContaining({ kind: 'line', sku: 'SKU-1' }),
    );
    expect(
      (
        await owner.query(
          'SELECT content IS NULL AS gone FROM messaging_documents WHERE id=$1',
          [plan.id],
        )
      ).rows[0].gone,
    ).toBe(true);
  });
});
