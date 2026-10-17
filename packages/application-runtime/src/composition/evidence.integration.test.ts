import { randomUUID } from 'node:crypto';

import { readShopifyEvidence } from '@luma/app-shopify';
import {
  builtInMembership,
  makeTenantContext,
  PermissionSet,
} from '@luma/identity';
import { createTenantDatabase } from '@luma/platform/composition';
import { createEvidenceReader } from '@luma/read-models/composition';
import { Pool, type PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';

import { createMigratedDatabase } from '../test-support/database.js';
import { createEvidenceOwners } from './read-models.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

function readerContext(
  tenantId: string,
  permissions?: string[],
  userId = randomUUID(),
) {
  const member = builtInMembership(
    { id: randomUUID(), organizationId: tenantId, userId },
    'member',
  );

  return makeTenantContext(
    { userId, sessionId: randomUUID() },
    {
      id: tenantId,
      name: 'Shop',
      slug: tenantId,
      dataRegion: 'AU',
      status: 'active',
    },
    permissions
      ? { ...member, permissions: new PermissionSet(permissions) }
      : member,
    randomUUID(),
  );
}

/** An executed action whose attempt cites a receipt and a verification read. */
async function executed(
  seed: PoolClient,
  tenantId: string,
  proposalId: string,
  attempt: { receipts: string[]; reads: string[]; at: string },
) {
  await seed.query(
    "INSERT INTO executed_actions(id,tenant_id,proposal_id,idempotency_key,action_hash,state,document) VALUES($1,$2,$3,$4,$5,'unknown',$6)",
    [
      randomUUID(),
      tenantId,
      proposalId,
      `v0:${proposalId}`,
      'a'.repeat(64),
      {
        state: 'unknown',
        tenantId,
        proposalId,
        intent: { capability: 'purchase-orders.submit' },
        attempt: {
          startedAt: attempt.at,
          finishedAt: attempt.at,
          effectEvidenceRefs: attempt.receipts,
          verification: {
            outcome: 'inconclusive',
            observationRefs: attempt.reads,
            observedAt: attempt.at,
          },
        },
      },
    ],
  );
}

describe.skipIf(!databaseUrl)('cited evidence on PostgreSQL', () => {
  it('resolves reads, receipts, records and unretained evidence per subject, with authorization and tenant isolation', async () => {
    const db = await createMigratedDatabase(databaseUrl!);
    const role = `evidence_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString: databaseUrl });
    let runtime: Pool | undefined;
    try {
      const password = randomUUID();
      await admin.query(
        `CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
      );
      // The API login's groups: desk owners and app-owned evidence.
      await admin.query(`GRANT luma_desk,luma_connectors TO "${role}"`);
      const url = new URL(db.owner.options.connectionString!);
      url.username = role;
      url.password = password;
      runtime = new Pool({ connectionString: url.toString() });
      const reader = createEvidenceReader(
        createTenantDatabase(runtime),
        createEvidenceOwners([{ appId: 'shopify', read: readShopifyEvidence }]),
      );

      const tenantId = randomUUID(),
        otherTenant = randomUUID(),
        connectionId = randomUUID(),
        orderId = randomUUID(),
        otherOrderId = randomUUID(),
        submissionId = randomUUID(),
        submissionAction = randomUUID(),
        readId = randomUUID(),
        receiptId = randomUUID(),
        otherReadId = randomUUID(),
        oldReadId = randomUUID(),
        lostReadId = randomUUID(),
        decisionId = randomUUID(),
        caseId = randomUUID(),
        settlementId = randomUUID(),
        returnReadId = randomUUID(),
        oldReturnRead = randomUUID(),
        threadId = randomUUID(),
        outboundId = randomUUID(),
        replyAction = randomUUID(),
        messageId = randomUUID(),
        sendReceiptId = randomUUID(),
        exceptionId = randomUUID(),
        caseAction = randomUUID(),
        shopifyRead = randomUUID(),
        shopifyAcceptance = randomUUID(),
        uncitedShopify = randomUUID(),
        observationId = randomUUID(),
        messageRecord = randomUUID(),
        stockAction = randomUUID(),
        stockAcceptance = randomUUID();
      const now = new Date().toISOString();
      const long = '2020-01-01T00:00:00.000Z';
      for (const tenant of [tenantId, otherTenant])
        await db.owner.query(
          "INSERT INTO organizations(data_region,id,name,slug,status,created_at) VALUES('AU',$1,'Shop',$2,'active',now())",
          [tenant, tenant],
        );

      const seed = await db.owner.connect();
      try {
        await seed.query('BEGIN');
        // Seed owner rows directly; their own services' constraints are covered elsewhere.
        await seed.query('SET LOCAL session_replication_role=replica');
        await seed.query(
          `INSERT INTO connector_installations(tenant_id,id,version,document,secret) VALUES($1,$2,1,$3,'sealed')`,
          [
            tenantId,
            connectionId,
            {
              tenantId,
              id: connectionId,
              version: 1,
              status: 'active',
              label: 'Main warehouse',
              target: { kind: 'jtl-cloud' },
            },
          ],
        );
        for (const [tenant, order] of [
          [tenantId, orderId],
          [otherTenant, otherOrderId],
        ] as const) {
          const supplierId = randomUUID();
          await seed.query(
            'INSERT INTO procurement_purchase_orders(tenant_id,id,supplier_id,document,created_at) VALUES($1,$2,$3,$4,now())',
            [
              tenant,
              order,
              supplierId,
              {
                tenantId: tenant,
                id: order,
                supplierId,
                status: 'open',
                authority: 'luma',
                lines: [{}],
              },
            ],
          );
        }
        await seed.query(
          `INSERT INTO procurement_submissions(tenant_id,id,purchase_order_id,connection_id,state,principal_id,document,created_at)
           VALUES($1,$2,$3,$4,'submitted','u',$5,now())`,
          [
            tenantId,
            submissionId,
            orderId,
            connectionId,
            {
              id: submissionId,
              tenantId,
              purchaseOrderId: orderId,
              actionId: submissionAction,
            },
          ],
        );
        const purchasingRead = (
          id: string,
          tenant: string,
          order: string,
          completeness: string,
        ) => ({
          id,
          tenantId: tenant,
          purchaseOrderId: order,
          purpose: 'submission',
          subjectId: submissionId,
          source: {
            provider: 'jtl',
            connectionId,
            resource: 'purchase_order',
            externalId: 'JTL-7',
            scopeKey: 'default',
          },
          observedAt: now,
          sourceUpdatedAt: now,
          sourceRevision: 'r3',
          adapterVersion: 'jtl-purchasing/2',
          completeness,
          data: {
            status: 'open',
            orderNumber: 'B-100',
            confirmed: false,
            lines: [{}, {}],
            supplier: { externalId: 'contact@supplier.example' },
          },
        });
        await seed.query(
          `INSERT INTO procurement_read_evidence(tenant_id,id,purchase_order_id,connection_id,purpose,subject_id,observed_at,document)
           VALUES($1,$2,$3,$4,'submission',$5,$6,$7),($8,$9,$10,$4,'submission',$5,$6,$11)`,
          [
            tenantId,
            readId,
            orderId,
            connectionId,
            submissionId,
            now,
            purchasingRead(readId, tenantId, orderId, 'partial'),
            otherTenant,
            otherReadId,
            otherOrderId,
            purchasingRead(otherReadId, otherTenant, otherOrderId, 'complete'),
          ],
        );
        await seed.query(
          `INSERT INTO procurement_read_evidence(tenant_id,id,purchase_order_id,connection_id,purpose,subject_id,observed_at,document,kind)
           VALUES($1,$2,$3,$4,'submission',$5,$6,$7,'write_receipt')`,
          [
            tenantId,
            receiptId,
            orderId,
            connectionId,
            submissionId,
            now,
            {
              kind: 'write_receipt',
              id: receiptId,
              tenantId,
              purchaseOrderId: orderId,
              purpose: 'submission',
              subjectId: submissionId,
              source: { provider: 'jtl', connectionId },
              capability: 'purchase-orders.submit',
              adapterVersion: 'jtl-purchasing/2',
              dispatchIdentity: 'jtl:1',
              idempotencyKey: `v0:${submissionAction}`,
              observedAt: now,
              status: 'accepted',
              providerRequestId: 'req-9',
              records: [{ resource: 'purchase_order', externalId: 'JTL-7' }],
            },
          ],
        );
        await executed(seed, tenantId, submissionAction, {
          receipts: [receiptId],
          reads: [readId, lostReadId],
          at: now,
        });
        await seed.query(
          'INSERT INTO policy_decisions(id,tenant_id,proposal_id,action_hash,document) VALUES($1,$2,$3,$4,$5)',
          [
            decisionId,
            tenantId,
            submissionAction,
            'a'.repeat(64),
            { id: decisionId, tenantId, outcome: 'approval_required' },
          ],
        );
        // A purchasing-system observation a commitment cites, and a supplier message.
        await seed.query(
          `INSERT INTO procurement_observations(tenant_id,id,purchase_order_id,connection_id,digest,document,observed_at)
           VALUES($1,$2,$3,$4,'d',$5,$6)`,
          [
            tenantId,
            observationId,
            orderId,
            connectionId,
            {
              externalId: 'JTL-7',
              status: 'open',
              orderNumber: 'B-100',
              confirmed: true,
              lines: [{}],
            },
            now,
          ],
        );
        await seed.query(
          `INSERT INTO procurement_communications(tenant_id,id,supplier_id,purchase_order_id,message_key,document,received_at,retain_until,created_at)
           VALUES($1,$2,$3,$4,'k',$5,now(),now()+interval '1 year',now())`,
          [
            tenantId,
            messageRecord,
            randomUUID(),
            orderId,
            { id: messageRecord, tenantId },
          ],
        );
        // A Shopify stock booking of the order's receipt, accepted by Shopify.
        const correctionId = randomUUID();
        await seed.query(
          `INSERT INTO shopify_inventory_corrections(tenant_id,id,connection_id,position_id,revision,document)
           VALUES($1,$2,$3,$4,'1',$5)`,
          [
            tenantId,
            correctionId,
            connectionId,
            randomUUID(),
            {
              id: correctionId,
              tenantId,
              action: { id: stockAction },
              target: { receipt: { purchaseOrderId: orderId } },
            },
          ],
        );
        await seed.query(
          `INSERT INTO shopify_inventory_evidence(tenant_id,connection_id,id,kind,observed_at,document) VALUES($1,$2,$3,'acceptance',$4,$5)`,
          [
            tenantId,
            connectionId,
            stockAcceptance,
            now,
            { adjustmentId: 'gid://2' },
          ],
        );
        await executed(seed, tenantId, stockAction, {
          receipts: [stockAcceptance],
          reads: [],
          at: now,
        });
        // A revision verified before purchasing reads were stored.
        const changeId = randomUUID();
        await seed.query(
          `INSERT INTO procurement_order_changes(tenant_id,id,purchase_order_id,state,document) VALUES($1,$2,$3,'verified',$4)`,
          [
            tenantId,
            changeId,
            orderId,
            {
              id: changeId,
              tenantId,
              purchaseOrderId: orderId,
              requestedAt: long,
              verifiedAt: long,
              observationRefs: [oldReadId],
            },
          ],
        );

        // A return settlement whose proof cites a stored read, an old read and the case revision.
        await seed.query(
          `INSERT INTO orders_return_cases(tenant_id,id,order_id,connection_id,state,revision,document,opened_at,updated_at)
           VALUES($1,$2,$3,$4,'open',2,$5,now(),now())`,
          [
            tenantId,
            caseId,
            randomUUID(),
            connectionId,
            { id: caseId, tenantId },
          ],
        );
        await seed.query(
          `INSERT INTO orders_return_actions(tenant_id,id,case_id,connection_id,kind,state,document,requested_at)
           VALUES($1,$2,$3,$4,'refund','verified',$5,now())`,
          [
            tenantId,
            settlementId,
            caseId,
            connectionId,
            {
              id: settlementId,
              tenantId,
              caseId,
              actionId: randomUUID(),
              quote: { observedAt: long, evidenceRefs: [oldReturnRead] },
              proof: {
                outcome: 'passed',
                observedAt: now,
                evidenceRefs: [returnReadId, `case:${caseId}:2`],
              },
            },
          ],
        );
        await seed.query(
          `INSERT INTO orders_return_read_evidence(tenant_id,id,case_id,connection_id,purpose,subject_id,observed_at,document)
           VALUES($1,$2,$3,$4,'settlement',$5,$6,$7)`,
          [
            tenantId,
            returnReadId,
            caseId,
            connectionId,
            settlementId,
            now,
            {
              id: returnReadId,
              tenantId,
              caseId,
              purpose: 'settlement',
              subjectId: settlementId,
              source: {
                provider: 'shopify',
                connectionId,
                resource: 'refund',
                externalId: 'gid://shopify/Refund/1',
                scopeKey: '',
              },
              observedAt: now,
              sourceUpdatedAt: null,
              sourceRevision: null,
              adapterVersion: 'shopify-returns/1',
              completeness: 'complete',
              data: { payment: 'paid', customerName: 'Ada Lovelace' },
            },
          ],
        );

        // A sent reply: its send receipt and the message the thread read found.
        await seed.query(
          `INSERT INTO messaging_mailboxes(tenant_id,connection_id,principal_id,document,due_at,revision,created_at,updated_at)
           VALUES($1,$2,'u',$3,now(),1,now(),now())`,
          [tenantId, connectionId, { provider: 'gmail' }],
        );
        await seed.query(
          `INSERT INTO messaging_threads(tenant_id,id,connection_id,provider_thread_id,subject,document,status,last_message_at,message_count,revision,created_at,updated_at)
           VALUES($1,$2,$3,'t-1','Delivery',$4,'open',now(),1,1,now(),now())`,
          [tenantId, threadId, connectionId, {}],
        );
        await seed.query(
          `INSERT INTO messaging_outbound(tenant_id,id,thread_id,connection_id,document,state,action_id,requested_by,revision,created_at,updated_at)
           VALUES($1,$2,$3,$4,$5,'sent',$6,'u',1,now(),now())`,
          [tenantId, outboundId, threadId, connectionId, {}, replyAction],
        );
        await seed.query(
          `INSERT INTO messaging_messages(tenant_id,id,thread_id,connection_id,provider_message_id,direction,from_address,document,origin,received_at,retain_until,created_at)
           VALUES($1,$2,$3,$4,'gmail-1','outbound','ops@shop.example',$5,'sync',$6,now()+interval '1 year',$6)`,
          [tenantId, messageId, threadId, connectionId, {}, now],
        );
        await seed.query(
          `INSERT INTO messaging_send_receipts(tenant_id,id,outbound_id,connection_id,accepted_at,document)
           VALUES($1,$2,$3,$4,$5,$6)`,
          [
            tenantId,
            sendReceiptId,
            outboundId,
            connectionId,
            now,
            {
              kind: 'write_receipt',
              id: sendReceiptId,
              tenantId,
              outboundId,
              threadId,
              source: { provider: 'gmail', connectionId },
              capability: 'messages.send',
              adapterVersion: 'gmail/1',
              dispatchIdentity: 'gmail:1',
              idempotencyKey: `v0:${replyAction}`,
              observedAt: now,
              status: 'accepted',
              providerRequestId: null,
              records: [{ resource: 'message', externalId: 'gmail-1' }],
            },
          ],
        );
        await executed(seed, tenantId, replyAction, {
          receipts: [sendReceiptId],
          reads: [messageId],
          at: now,
        });

        // A case whose Shopify correction cites the app's own evidence.
        await seed.query(
          `INSERT INTO exceptions(id,tenant_id,fingerprint,state,document) VALUES($1,$2,$3,'verifying',$4)`,
          [
            exceptionId,
            tenantId,
            'f'.repeat(64),
            {
              id: exceptionId,
              tenantId,
              state: 'verifying',
              fingerprint: 'f'.repeat(64),
              occurrenceCount: 1,
              exceptionClass: 'inventory_mismatch',
              severity: 'high',
            },
          ],
        );
        await seed.query(
          `INSERT INTO case_proposals(tenant_id,id,exception_id,diagnosis_revision,action_hash,document) VALUES($1,$2,$3,1,$4,$5)`,
          [
            tenantId,
            caseAction,
            exceptionId,
            'a'.repeat(64),
            { id: caseAction, tenantId },
          ],
        );
        for (const [id, kind, document] of [
          [shopifyRead, 'observation', { complete: true, available: 4 }],
          [shopifyAcceptance, 'acceptance', { adjustmentId: 'gid://1' }],
          [uncitedShopify, 'observation', { complete: false }],
        ] as const)
          await seed.query(
            `INSERT INTO shopify_inventory_evidence(tenant_id,connection_id,id,kind,observed_at,document) VALUES($1,$2,$3,$4,$5,$6)`,
            [tenantId, connectionId, id, kind, now, document],
          );
        await executed(seed, tenantId, caseAction, {
          receipts: [shopifyAcceptance],
          reads: [shopifyRead],
          at: now,
        });
        await seed.query('COMMIT');
      } catch (error) {
        await seed.query('ROLLBACK');
        throw error;
      } finally {
        seed.release();
      }

      const reading = readerContext(tenantId);
      const start = (
        await db.owner.query<{ started_at: Date }>(
          "SELECT started_at FROM evidence_retention_starts WHERE kind='procurement_reads'",
        )
      ).rows[0]!.started_at.toISOString();

      // Everything the order cites, without naming references.
      const order = await reader.resolve(reading, {
        subject: { kind: 'purchase_order', id: orderId },
      });
      const byRef = new Map(order.items.map((item) => [item.ref, item]));
      expect(byRef.get(readId)).toMatchObject({
        citedAs: 'read',
        resolution: {
          kind: 'read',
          provider: 'jtl',
          connection: { id: connectionId, label: 'Main warehouse' },
          record: { resource: 'purchase_order', externalId: 'JTL-7' },
          sourceRevision: 'r3',
          completeness: 'partial',
          adapterVersion: 'jtl-purchasing/2',
          summary: [
            { field: 'status', value: 'open' },
            { field: 'orderNumber', value: 'B-100' },
            { field: 'confirmed', value: 'false' },
            { field: 'lines', value: '2' },
          ],
        },
      });
      expect(JSON.stringify(order)).not.toContain('contact@supplier.example');
      expect(byRef.get(receiptId)).toMatchObject({
        citedAs: 'write_receipt',
        resolution: {
          kind: 'write_receipt',
          capability: 'purchase-orders.submit',
          providerRequestId: 'req-9',
          records: [{ resource: 'purchase_order', externalId: 'JTL-7' }],
        },
      });
      // Cited after storage began but never stored: Luma can't explain it away.
      expect(byRef.get(lostReadId)?.resolution).toEqual({ kind: 'unresolved' });
      expect(byRef.get(oldReadId)?.resolution).toEqual({
        kind: 'not_retained',
        retentionStartedAt: start,
      });
      expect(order.truncated).toBe(false);

      // Named references: records of this order resolve, another tenant's read does not.
      const named = await reader.resolve(reading, {
        subject: { kind: 'purchase_order', id: orderId },
        refs: [
          decisionId,
          orderId,
          submissionId,
          messageRecord,
          observationId,
          otherReadId,
          'not-a-uuid',
        ],
      });
      expect(named.items.map((item) => item.resolution)).toEqual([
        { kind: 'luma_record', record: 'policy_decision', id: decisionId },
        { kind: 'luma_record', record: 'purchase_order', id: orderId },
        { kind: 'luma_record', record: 'submission', id: submissionId },
        { kind: 'luma_record', record: 'supplier_message', id: messageRecord },
        expect.objectContaining({
          kind: 'read',
          record: { resource: 'purchase_order', externalId: 'JTL-7' },
          // Observations predate read evidence and record no completeness.
          completeness: null,
          summary: [
            { field: 'status', value: 'open' },
            { field: 'orderNumber', value: 'B-100' },
            { field: 'confirmed', value: 'true' },
            { field: 'lines', value: '1' },
          ],
        }),
        { kind: 'unresolved' },
        { kind: 'unresolved' },
      ]);

      // Stock booking proof needs inventory access as well as procurement access.
      expect(byRef.get(stockAcceptance)).toMatchObject({
        citedAs: 'write_receipt',
        resolution: { kind: 'write_receipt', provider: 'shopify' },
      });
      const withoutStock = await reader.resolve(
        readerContext(tenantId, ['procurement.read']),
        { subject: { kind: 'purchase_order', id: orderId } },
      );
      expect(withoutStock.items.map((item) => item.ref)).not.toContain(
        stockAcceptance,
      );
      expect(
        (
          await reader.resolve(readerContext(tenantId, ['procurement.read']), {
            subject: { kind: 'purchase_order', id: orderId },
            refs: [stockAcceptance],
          })
        ).items[0]?.resolution,
      ).toEqual({ kind: 'unresolved' });

      const settlement = await reader.resolve(reading, {
        subject: { kind: 'return_settlement', id: settlementId },
      });
      expect(
        settlement.items.map((item) => [item.ref, item.resolution.kind]),
      ).toEqual([
        [returnReadId, 'read'],
        [`case:${caseId}:2`, 'luma_record'],
        [oldReturnRead, 'not_retained'],
      ]);
      expect(settlement.items[0]?.resolution).toMatchObject({
        summary: [{ field: 'payment', value: 'paid' }],
      });
      expect(JSON.stringify(settlement)).not.toContain('Ada Lovelace');

      const reply = await reader.resolve(reading, {
        subject: { kind: 'reply', id: outboundId },
      });
      expect(reply.items).toEqual([
        expect.objectContaining({
          ref: sendReceiptId,
          resolution: expect.objectContaining({
            kind: 'write_receipt',
            provider: 'gmail',
            capability: 'messages.send',
          }),
        }),
        expect.objectContaining({
          ref: messageId,
          resolution: expect.objectContaining({
            kind: 'read',
            provider: 'gmail',
            record: { resource: 'message', externalId: 'gmail-1' },
            completeness: null,
          }),
        }),
      ]);
      expect(JSON.stringify(reply)).not.toContain('ops@shop.example');

      // App evidence resolves only for references the case's attempts cite.
      const issue = await reader.resolve(reading, {
        subject: { kind: 'case', id: exceptionId },
        refs: [shopifyAcceptance, shopifyRead, uncitedShopify, caseAction],
      });
      expect(issue.items.map((item) => item.resolution)).toEqual([
        expect.objectContaining({
          kind: 'write_receipt',
          provider: 'shopify',
          // The acceptance names no capability; the citing attempt does.
          capability: 'purchase-orders.submit',
        }),
        expect.objectContaining({
          kind: 'read',
          provider: 'shopify',
          // This inventory read predates recorded completeness; its `complete` flag meant
          // the item could be corrected, so neither shows as read completeness.
          completeness: null,
          summary: [{ field: 'available', value: '4' }],
        }),
        { kind: 'unresolved' },
        { kind: 'luma_record', record: 'case_proposal', id: caseAction },
      ]);

      // One request resolves at most 100 references.
      await expect(
        reader.resolve(reading, {
          subject: { kind: 'purchase_order', id: orderId },
          refs: Array.from({ length: 101 }, () => randomUUID()),
        }),
      ).rejects.toMatchObject({ statusCode: 422 });
      // The subject area's read permission is required.
      await expect(
        reader.resolve(readerContext(tenantId, ['issues.read']), {
          subject: { kind: 'purchase_order', id: orderId },
        }),
      ).rejects.toMatchObject({ statusCode: 403 });
      // Another tenant's reader cannot see this tenant's subjects.
      await expect(
        reader.resolve(readerContext(otherTenant), {
          subject: { kind: 'purchase_order', id: orderId },
        }),
      ).rejects.toMatchObject({ statusCode: 404 });
      await expect(
        reader.resolve(readerContext(otherTenant), {
          subject: { kind: 'reply', id: outboundId },
        }),
      ).rejects.toMatchObject({ statusCode: 404 });
      // Its own order resolves only its own read.
      const other = await reader.resolve(readerContext(otherTenant), {
        subject: { kind: 'purchase_order', id: otherOrderId },
        refs: [otherReadId, readId],
      });
      expect(other.items.map((item) => item.resolution.kind)).toEqual([
        'read',
        'unresolved',
      ]);
    } finally {
      await runtime?.end();
      await db.drop();
      await admin.query(`DROP ROLE IF EXISTS "${role}"`);
      await admin.end();
    }
  }, 60_000);

  it('resolves plan inputs, lifecycle events, native receipts, order emails and app decisions through their owners, with restricted access and tenant isolation', async () => {
    const db = await createMigratedDatabase(databaseUrl!);
    const role = `evidence_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString: databaseUrl });
    let runtime: Pool | undefined;
    try {
      const password = randomUUID();
      await admin.query(
        `CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
      );
      await admin.query(`GRANT luma_desk,luma_connectors TO "${role}"`);
      const url = new URL(db.owner.options.connectionString!);
      url.username = role;
      url.password = password;
      runtime = new Pool({ connectionString: url.toString() });
      const reader = createEvidenceReader(
        createTenantDatabase(runtime),
        createEvidenceOwners([{ appId: 'shopify', read: readShopifyEvidence }]),
      );

      const id = () => randomUUID();
      const tenantId = id(),
        otherTenant = id(),
        shopify = id(),
        mailbox = id(),
        supplierId = id(),
        orderId = id(),
        sourceOrderId = id(),
        otherOrderId = id(),
        planId = id(),
        planAction = id(),
        planDecision = id(),
        stockRead = id(),
        demandRead = id(),
        position = id(),
        orderEntity = id(),
        sku = id(),
        location = id(),
        account = id(),
        reviewId = id(),
        entryId = id(),
        receiptCommitment = id(),
        sourceCommitment = id(),
        eventId = id(),
        approver = id(),
        submissionId = id(),
        threadId = id(),
        messageId = id(),
        appProposal = id(),
        runId = id(),
        shopifyRead = id();
      const now = new Date().toISOString();
      for (const tenant of [tenantId, otherTenant])
        await db.owner.query(
          "INSERT INTO organizations(data_region,id,name,slug,status,created_at) VALUES('AU',$1,'Shop',$2,'active',now())",
          [tenant, tenant],
        );

      const seed = await db.owner.connect();
      try {
        await seed.query('BEGIN');
        // Seed owner rows directly; their own services' constraints are covered elsewhere.
        await seed.query('SET LOCAL session_replication_role=replica');
        for (const [connection, label, provider] of [
          [shopify, 'Shopify store', 'shopify'],
          [mailbox, 'Purchasing inbox', 'gmail'],
        ] as const)
          await seed.query(
            `INSERT INTO connector_installations(tenant_id,id,version,document,secret) VALUES($1,$2,1,$3,'sealed')`,
            [
              tenantId,
              connection,
              {
                tenantId,
                id: connection,
                version: 1,
                status: 'active',
                label,
                provider,
                target: { kind: provider },
              },
            ],
          );
        await seed.query(
          `INSERT INTO workspace_people(tenant_id,user_id,name,email) VALUES($1,$2,'Mara Lind','mara@example.test')`,
          [tenantId, approver],
        );
        await seed.query(
          'INSERT INTO procurement_suppliers(tenant_id,id,document) VALUES($1,$2,$3)',
          [tenantId, supplierId, { tenantId, id: supplierId }],
        );
        for (const [tenant, order] of [
          [tenantId, orderId],
          [tenantId, sourceOrderId],
          [otherTenant, otherOrderId],
        ] as const)
          await seed.query(
            'INSERT INTO procurement_purchase_orders(tenant_id,id,supplier_id,document,created_at) VALUES($1,$2,$3,$4,now())',
            [
              tenant,
              order,
              supplierId,
              {
                tenantId: tenant,
                id: order,
                supplierId,
                status: 'open',
                authority: 'luma',
                lines: [{}],
              },
            ],
          );

        // A purchasing plan that drafted the order: stock, demand and native ledger reads, and
        // the shortfall of another order it reorders.
        await seed.query(
          `INSERT INTO procurement_purchasing_plans(tenant_id,id,supplier_id,document,digest,created_at) VALUES($1,$2,$3,$4,'d',$5)`,
          [
            tenantId,
            planId,
            supplierId,
            {
              tenantId,
              id: planId,
              actionId: planAction,
              decisionId: planDecision,
              order: { id: orderId },
              request: { sourceOrderId },
              suggestions: [
                {
                  evidenceRefs: [
                    stockRead,
                    demandRead,
                    entryId,
                    sourceOrderId,
                    sourceCommitment,
                  ],
                },
              ],
            },
            now,
          ],
        );
        await seed.query(
          'INSERT INTO policy_decisions(id,tenant_id,proposal_id,action_hash,document) VALUES($1,$2,$3,$4,$5)',
          [
            planDecision,
            tenantId,
            planAction,
            'a'.repeat(64),
            { id: planDecision, tenantId, outcome: 'approval_required' },
          ],
        );
        for (const [observation, resource, externalId] of [
          [stockRead, 'sku', 'gid://shopify/InventoryLevel/1'],
          [demandRead, 'order', 'gid://shopify/Order/7'],
        ] as const)
          await seed.query(
            `INSERT INTO connector_observations(id,tenant_id,connection_id,ingest_key,document) VALUES($1,$2,$3,$4,$5)`,
            [
              observation,
              tenantId,
              shopify,
              observation,
              {
                observation: {
                  id: observation,
                  source: {
                    tenantId,
                    connectionId: shopify,
                    provider: 'shopify',
                    resource,
                    externalId,
                  },
                  sourceRevision: 'r7',
                  adapterVersion: 'shopify-inventory/3',
                },
              },
            ],
          );
        await seed.query(
          `INSERT INTO inventory_entities(id,tenant_id,kind,reconciliation_key) VALUES($1,$2,'position','p'),($3,$2,'sku','s'),($4,$2,'location','l')`,
          [position, tenantId, sku, location],
        );
        await seed.query(
          `INSERT INTO inventory_snapshots(id,tenant_id,entity_id,kind,connection_id,observation_id,normalizer_version,mapping_version,observed_at,document)
           VALUES($1,$2,$3,'position',$4,$5,'n1','m1',$6,$7)`,
          [
            id(),
            tenantId,
            position,
            shopify,
            stockRead,
            now,
            {
              entityId: position,
              connectionId: shopify,
              observationId: stockRead,
              kind: 'position',
              data: { available: '4', reserved: '1', unit: 'each', note: 'x' },
            },
          ],
        );
        await seed.query(
          `INSERT INTO orders_entities(id,tenant_id,kind,reconciliation_key) VALUES($1,$2,'order','o')`,
          [orderEntity, tenantId],
        );
        await seed.query(
          `INSERT INTO orders_snapshots(id,tenant_id,entity_id,kind,connection_id,observation_id,normalizer_version,mapping_version,observed_at,document)
           VALUES($1,$2,$3,'order',$4,$5,'n1','m1',$6,$7)`,
          [
            id(),
            tenantId,
            orderEntity,
            shopify,
            demandRead,
            now,
            {
              entityId: orderEntity,
              connectionId: shopify,
              observationId: demandRead,
              kind: 'order',
              data: {
                status: 'open',
                lines: [{}, {}],
                customer: { email: 'ada@example.com' },
              },
            },
          ],
        );

        // A native receipt review, the ledger entry that booked it and the facts it books.
        await seed.query(
          `INSERT INTO inventory_ledger_accounts(tenant_id,id,sku_id,location_id,unit,state,balance,version) VALUES($1,$2,$3,$4,'each','available',24,1)`,
          [tenantId, account, sku, location],
        );
        const commandKey = `purchase-receipt:${orderId}:line`;
        await seed.query(
          `INSERT INTO inventory_ledger_reviews(tenant_id,id,command_key,intent_hash,command_hash,command_document,source_bindings,prepared_by,state,reviewed_by,reviewed_at)
           VALUES($1,$2,$3,$4,$5,$6,'{}','preparer','approved',$7,$8)`,
          [
            tenantId,
            reviewId,
            commandKey,
            'a'.repeat(64),
            'b'.repeat(64),
            {
              purchaseReceipt: {
                purchaseOrderId: orderId,
                lineId: 'line',
                commitmentId: receiptCommitment,
                damagedCommitmentId: null,
                cumulativeGood: '24.000000',
              },
              postings: [
                {
                  account: { state: 'available', unit: 'each' },
                  quantity: '24',
                },
              ],
            },
            approver,
            now,
          ],
        );
        await seed.query(
          `INSERT INTO inventory_ledger_entries(tenant_id,id,command_key,command_hash,purpose,reason,actor_id,evidence_refs,review_id)
           VALUES($1,$2,$3,$4,'purchase_receipt','Received',$5,'[]',$6)`,
          [tenantId, entryId, commandKey, 'b'.repeat(64), approver, reviewId],
        );
        await seed.query(
          `INSERT INTO inventory_ledger_postings(tenant_id,entry_id,account_id,sku_id,unit,account_version,quantity,balance_before,balance_after,recorded_at)
           VALUES($1,$2,$3,$4,'each',1,24,0,24,$5)`,
          [tenantId, entryId, account, sku, now],
        );
        for (const [commitment, order, kind, source] of [
          [
            receiptCommitment,
            orderId,
            'received',
            {
              kind: 'manual_receipt',
              reason: 'Counted',
              evidence: ['Delivery note 4471'],
            },
          ],
          [
            sourceCommitment,
            sourceOrderId,
            'confirmed',
            { kind: 'correction' },
          ],
        ] as const)
          await seed.query(
            `INSERT INTO procurement_commitments(tenant_id,id,purchase_order_id,source_key,document,recorded_at) VALUES($1,$2::uuid,$3,$2::text,$4,$5)`,
            [
              tenantId,
              commitment,
              order,
              {
                id: commitment,
                purchaseOrderId: order,
                kind,
                status: 'confirmed',
                source,
              },
              now,
            ],
          );

        // A status change of the order, recorded by a member.
        await seed.query(
          `INSERT INTO audit_entries(id,tenant_id,event_key,proposal_id,document) VALUES($1,$2,'procurement:e',$3,$4)`,
          [
            eventId,
            tenantId,
            orderId,
            {
              id: eventId,
              tenantId,
              eventType: 'purchase_order.status_changed',
              occurredAt: now,
              actor: { kind: 'user', id: approver },
              details: { from: 'draft', to: 'open', revision: '2' },
            },
          ],
        );

        // An email submission and the order email the inbox sent.
        await seed.query(
          `INSERT INTO procurement_submissions(tenant_id,id,purchase_order_id,connection_id,state,principal_id,document,created_at)
           VALUES($1,$2,$3,$4,'submitted','u',$5,now())`,
          [
            tenantId,
            submissionId,
            orderId,
            mailbox,
            {
              id: submissionId,
              tenantId,
              purchaseOrderId: orderId,
              channel: 'email',
              outgoing: {
                outboundId: id(),
                threadId,
                sentMessageId: messageId,
              },
            },
          ],
        );
        await seed.query(
          `INSERT INTO messaging_mailboxes(tenant_id,connection_id,principal_id,document,due_at,revision,created_at,updated_at)
           VALUES($1,$2,'u',$3,now(),1,now(),now())`,
          [tenantId, mailbox, { provider: 'gmail' }],
        );
        await seed.query(
          `INSERT INTO messaging_threads(tenant_id,id,connection_id,provider_thread_id,subject,document,status,last_message_at,message_count,revision,created_at,updated_at)
           VALUES($1,$2,$3,'t-1','PO',$4,'open',now(),1,1,now(),now())`,
          [tenantId, threadId, mailbox, {}],
        );
        await seed.query(
          `INSERT INTO messaging_messages(tenant_id,id,thread_id,connection_id,provider_message_id,direction,from_address,document,body,origin,received_at,retain_until,created_at)
           VALUES($1,$2,$3,$4,'gmail-1','outbound','buying@shop.example',$5,'SECRET BODY TEXT','luma',$6,now()+interval '1 year',$6)`,
          [
            tenantId,
            messageId,
            threadId,
            mailbox,
            {
              from: { address: 'buying@shop.example', name: 'Shop buying' },
              to: [{ address: 'orders@supplier.example', name: null }],
              subject: 'Purchase order PO-1',
              senderAuthentication: 'aligned',
            },
            now,
          ],
        );

        // A Shopify stock correction awaiting approval, admitted with the read it rests on.
        await seed.query(
          `INSERT INTO action_admission_steps(tenant_id,run_id,step_id,proposal_id,artifact_id,artifact_version,document)
           VALUES($1,$2,'apply',$3,'a','1',$4)`,
          [
            tenantId,
            runId,
            appProposal,
            {
              tenantId,
              runId,
              stepId: 'apply',
              action: {
                id: appProposal,
                capability: 'inventory.available.reconcile',
                preconditions: { evidenceRefs: [shopifyRead] },
              },
            },
          ],
        );
        await seed.query(
          `INSERT INTO shopify_inventory_evidence(tenant_id,connection_id,id,kind,observed_at,document) VALUES($1,$2,$3,'observation',$4,$5)`,
          [
            tenantId,
            shopify,
            shopifyRead,
            now,
            { complete: true, available: 4 },
          ],
        );
        await seed.query('COMMIT');
      } catch (error) {
        await seed.query('ROLLBACK');
        throw error;
      } finally {
        seed.release();
      }

      const reading = readerContext(tenantId);
      const procurementOnly = readerContext(tenantId, ['procurement.read']);
      const kinds = (items: { ref: string; resolution: { kind: string } }[]) =>
        Object.fromEntries(items.map((item) => [item.ref, item.resolution]));
      const mara = {
        kind: 'member',
        id: approver,
        name: 'Mara Lind',
        email: 'mara@example.test',
        workflow: null,
      };

      // The plan: its inputs resolve through the inventory and orders owners.
      const plan = await reader.resolve(reading, {
        subject: { kind: 'purchasing_plan', id: planId },
      });
      const planItems = kinds(plan.items);
      expect(planItems[stockRead]).toMatchObject({
        kind: 'read',
        provider: 'shopify',
        connection: { id: shopify, label: 'Shopify store' },
        record: {
          resource: 'sku',
          externalId: 'gid://shopify/InventoryLevel/1',
        },
        sourceRevision: 'r7',
        adapterVersion: 'shopify-inventory/3',
        summary: [
          { field: 'available', value: '4' },
          { field: 'reserved', value: '1' },
        ],
      });
      expect(planItems[demandRead]).toMatchObject({
        kind: 'read',
        summary: [
          { field: 'status', value: 'open' },
          { field: 'lines', value: '2' },
        ],
      });
      expect(JSON.stringify(plan)).not.toContain('ada@example.com');
      expect(planItems[entryId]).toEqual({
        kind: 'luma_record',
        record: 'ledger_entry',
        id: entryId,
        at: expect.any(String),
        actor: mara,
        detail: {
          kind: 'ledger_entry',
          purpose: 'purchase_receipt',
          reversed: false,
          postings: [
            {
              state: 'available',
              unit: 'each',
              quantity: '24',
              balanceAfter: '24',
              version: 1,
            },
          ],
        },
      });
      expect(planItems[planId]).toMatchObject({ record: 'purchasing_plan' });
      expect(planItems[planDecision]).toMatchObject({
        record: 'policy_decision',
      });
      expect(planItems[sourceOrderId]).toMatchObject({
        record: 'purchase_order',
      });
      expect(planItems[sourceCommitment]).toMatchObject({
        record: 'commitment',
      });
      expect(
        plan.items.find((item) => item.ref === sourceCommitment)?.citedAs,
      ).toBe('record');
      expect(plan.items.find((item) => item.ref === stockRead)?.citedAs).toBe(
        'read',
      );

      // Without inventory and order access the plan's inputs are restricted, not dropped.
      const restrictedPlan = kinds(
        (
          await reader.resolve(procurementOnly, {
            subject: { kind: 'purchasing_plan', id: planId },
          })
        ).items,
      );
      expect(restrictedPlan[stockRead]).toEqual({
        kind: 'restricted',
        permission: 'inventory.read',
      });
      expect(restrictedPlan[entryId]).toEqual({
        kind: 'restricted',
        permission: 'inventory.read',
      });
      expect(restrictedPlan[demandRead]).toEqual({
        kind: 'restricted',
        permission: 'orders.read',
      });

      // The order's timeline references: event, native receipt, ledger proof, email, note.
      const refs = [
        eventId,
        reviewId,
        entryId,
        messageId,
        'Delivery note 4471',
        stockRead,
        planId,
      ];
      const order = await reader.resolve(reading, {
        subject: { kind: 'purchase_order', id: orderId },
        refs,
      });
      const orderItems = kinds(order.items);
      expect(orderItems[eventId]).toEqual({
        kind: 'luma_record',
        record: 'procurement_event',
        id: eventId,
        at: now,
        actor: mara,
        detail: {
          kind: 'procurement_event',
          event: 'status_changed',
          from: 'draft',
          to: 'open',
          revision: 2,
        },
      });
      expect(orderItems[reviewId]).toMatchObject({
        kind: 'luma_record',
        record: 'stock_receipt_review',
        actor: mara,
        detail: {
          kind: 'stock_receipt_review',
          state: 'approved',
          quantity: '24',
          unit: 'each',
        },
      });
      expect(orderItems[entryId]).toMatchObject({ record: 'ledger_entry' });
      expect(orderItems[messageId]).toEqual({
        kind: 'message',
        provider: 'gmail',
        connection: { id: mailbox, label: 'Purchasing inbox' },
        direction: 'outbound',
        sender: { address: 'buying@shop.example', name: 'Shop buying' },
        receivedAt: now,
        subject: 'Purchase order PO-1',
        senderAuthentication: 'aligned',
      });
      expect(JSON.stringify(order)).not.toContain('SECRET BODY TEXT');
      expect(JSON.stringify(order)).not.toContain('orders@supplier.example');
      expect(orderItems['Delivery note 4471']).toEqual({
        kind: 'luma_record',
        record: 'receipt_note',
        id: receiptCommitment,
      });
      expect(orderItems[stockRead]).toMatchObject({ kind: 'read' });
      expect(orderItems[planId]).toMatchObject({ record: 'purchasing_plan' });
      expect(
        order.items.filter((item) => item.resolution.kind === 'unresolved'),
      ).toEqual([]);

      // Each guarded area stays restricted for a procurement-only reader.
      const restrictedOrder = kinds(
        (
          await reader.resolve(procurementOnly, {
            subject: { kind: 'purchase_order', id: orderId },
            refs,
          })
        ).items,
      );
      expect(restrictedOrder[eventId]).toMatchObject({
        record: 'procurement_event',
      });
      expect(restrictedOrder[reviewId]).toEqual({
        kind: 'restricted',
        permission: 'inventory.read',
      });
      expect(restrictedOrder[entryId]).toEqual({
        kind: 'restricted',
        permission: 'inventory.read',
      });
      expect(restrictedOrder[messageId]).toEqual({
        kind: 'restricted',
        permission: 'messages.read',
      });

      // The native receipt review on its own, needing inventory access.
      const receipt = await reader.resolve(reading, {
        subject: { kind: 'native_receipt', id: reviewId },
      });
      expect(
        receipt.items.map((item) => [item.ref, item.resolution.kind]),
      ).toEqual([
        [reviewId, 'luma_record'],
        [receiptCommitment, 'luma_record'],
        [entryId, 'luma_record'],
      ]);
      expect(
        kinds(
          (
            await reader.resolve(readerContext(tenantId, ['inventory.read']), {
              subject: { kind: 'native_receipt', id: reviewId },
            })
          ).items,
        )[receiptCommitment],
      ).toEqual({ kind: 'restricted', permission: 'procurement.read' });
      await expect(
        reader.resolve(procurementOnly, {
          subject: { kind: 'native_receipt', id: reviewId },
        }),
      ).rejects.toMatchObject({ statusCode: 403 });

      // An app decision: the proposal and the Shopify read its preconditions cite.
      const decision = await reader.resolve(reading, {
        subject: { kind: 'app_decision', id: appProposal },
      });
      expect(
        decision.items.map((item) => [item.ref, item.resolution.kind]),
      ).toEqual([
        [appProposal, 'luma_record'],
        [shopifyRead, 'read'],
      ]);
      await expect(
        reader.resolve(readerContext(tenantId, ['orders.read']), {
          subject: { kind: 'app_decision', id: appProposal },
        }),
      ).rejects.toMatchObject({ statusCode: 403 });

      // Another tenant sees none of these subjects or references.
      const outsider = readerContext(otherTenant);
      for (const subject of [
        { kind: 'purchasing_plan', id: planId },
        { kind: 'native_receipt', id: reviewId },
        { kind: 'app_decision', id: appProposal },
      ] as const)
        await expect(
          reader.resolve(outsider, { subject }),
        ).rejects.toMatchObject({ statusCode: 404 });
      const foreign = await reader.resolve(outsider, {
        subject: { kind: 'purchase_order', id: otherOrderId },
        refs: [eventId, reviewId, messageId, stockRead],
      });
      expect(foreign.items.map((item) => item.resolution.kind)).toEqual([
        'unresolved',
        'unresolved',
        'unresolved',
        'unresolved',
      ]);
    } finally {
      await runtime?.end();
      await db.drop();
      await admin.query(`DROP ROLE IF EXISTS "${role}"`);
      await admin.end();
    }
  }, 60_000);
});
