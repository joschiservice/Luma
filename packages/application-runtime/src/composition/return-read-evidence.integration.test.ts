import { randomUUID } from 'node:crypto';

import { createAuditLog } from '@luma/audit/composition';
import { builtInMembership, makeTenantContext } from '@luma/identity';
import {
  createReturnActionService,
  type ReturnRead,
} from '@luma/orders/composition';
import { createTenantDatabase } from '@luma/platform/composition';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { createMigratedDatabase } from '../test-support/database.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const unused = async (): Promise<never> => {
  throw new Error('Not used by settlement verification');
};

describe.skipIf(!databaseUrl)('return read evidence on PostgreSQL', () => {
  it('stores each cited settlement read once, append-only and tenant-scoped', async () => {
    const db = await createMigratedDatabase(databaseUrl!);
    const role = `return_reads_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString: databaseUrl });
    let runtime: Pool | undefined;
    try {
      const password = randomUUID();
      await admin.query(
        `CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
      );
      await admin.query(`GRANT luma_desk,luma_audit TO "${role}"`);
      const url = new URL(db.owner.options.connectionString!);
      url.username = role;
      url.password = password;
      runtime = new Pool({ connectionString: url.toString() });
      const database = createTenantDatabase(runtime);
      const tenantId = randomUUID(),
        otherTenant = randomUUID(),
        userId = randomUUID(),
        orderId = randomUUID(),
        caseId = randomUUID(),
        actionId = randomUUID(),
        connectionId = randomUUID(),
        readId = randomUUID();
      for (const tenant of [tenantId, otherTenant])
        await db.owner.query(
          "INSERT INTO organizations(data_region,id,name,slug,status,created_at) VALUES('AU',$1,'Shop',$2,'active',now())",
          [tenant, tenant],
        );
      const context = makeTenantContext(
        { userId, sessionId: randomUUID() },
        {
          id: tenantId,
          name: 'Shop',
          slug: 'shop',
          dataRegion: 'AU',
          status: 'active',
        },
        builtInMembership(
          { id: randomUUID(), organizationId: tenantId, userId },
          'owner',
        ),
        randomUUID(),
      );
      const now = new Date().toISOString();
      const decided = {
        by: userId,
        at: now,
        evidence: { note: 'Counted', link: null },
      };
      const value = {
        id: caseId,
        tenantId,
        orderId,
        connectionId,
        sourceReturnId: null,
        state: 'open',
        lines: [
          {
            orderLineId: randomUUID(),
            quantity: 1,
            reason: 'other',
            note: null,
            sku: null,
            title: null,
          },
        ],
        assigneeId: null,
        receipt: null,
        inspection: null,
        proposal: { ...decided, kind: 'refund', lines: [] },
        revision: 1,
        openedBy: userId,
        openedAt: now,
        updatedAt: now,
        cancellation: null,
      };
      const action = {
        id: actionId,
        intentVersion: 2,
        tenantId,
        caseId,
        connectionId,
        orderLineId: null,
        kind: 'refund',
        mappingIds: [],
        plan: {
          kind: 'refund',
          order: { externalId: 'gid://shopify/Order/1', scopeKey: '' },
          lines: [],
          amount: '10',
          currency: 'EUR',
          transactions: [],
        },
        quote: { observedAt: now, evidenceRefs: [] },
        caseDigest: 'facts',
        requestDigest: 'request',
        actionId: randomUUID(),
        requestedBy: userId,
        requestedAt: now,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        decisionId: null,
        decidedBy: null,
        decidedAt: null,
        state: 'uncertain',
        sent: true,
        proof: null,
        failure: null,
        updatedAt: now,
      };
      await db.owner.query(
        "INSERT INTO orders_entities(id,tenant_id,kind,reconciliation_key) VALUES($1,$2,'order','return-evidence')",
        [orderId, tenantId],
      );
      await db.owner.query(
        `INSERT INTO orders_return_cases(tenant_id,id,order_id,connection_id,state,revision,document,opened_at,updated_at)
         VALUES($1,$2,$3,$4,'open',1,$5,$6,$6)`,
        [tenantId, caseId, orderId, connectionId, value, now],
      );
      await db.owner.query(
        `INSERT INTO orders_return_actions(tenant_id,id,case_id,connection_id,kind,order_line_id,state,sent,document,requested_at)
         VALUES($1,$2,$3,$4,'refund',NULL,'uncertain',true,$5,$6)`,
        [tenantId, actionId, caseId, connectionId, action, now],
      );
      const read: ReturnRead = {
        id: readId,
        source: {
          provider: 'shopify',
          connectionId,
          resource: 'refund',
          externalId: actionId,
          scopeKey: '',
        },
        observedAt: new Date().toISOString(),
        sourceUpdatedAt: null,
        sourceRevision: null,
        adapterVersion: 'shopify-returns/1',
        completeness: 'complete',
        data: { operationId: actionId, outcome: 'passed', payment: 'paid' },
      };
      const actions = createReturnActionService(database, createAuditLog, {
        system: {
          warehouses: unused,
          quote: unused,
          proof: async () => ({
            outcome: 'passed',
            payment: 'paid',
            observedAt: read.observedAt,
            evidenceRefs: [readId],
            reads: [read],
          }),
        },
        admission: null,
        refreshContext: async (c) => c,
        principal: unused,
      });

      const verification = await actions.verify(context, actionId);
      const checked = await actions.check(context, caseId, actionId);
      expect(verification).toEqual({
        outcome: 'passed',
        observationRefs: [readId],
      });
      expect(checked).toMatchObject({
        state: 'verified',
        proof: { evidenceRefs: [readId], complete: true },
      });

      // Every reference verification, the stored proof and the audit cite resolves to one read.
      const audited = (
        await createAuditLog(database).list(tenantId, action.actionId)
      )
        .filter((e) => e.eventType === 'return.settlement.verified')
        .flatMap((e) => e.evidenceRefs);
      expect(audited).toEqual([readId]);
      await database.transaction(tenantId, async (tx) => {
        const stored = await tx.query<{
          id: string;
          case_id: string;
          connection_id: string;
          purpose: string;
          subject_id: string;
          document: Record<string, unknown>;
        }>(
          'SELECT id,case_id,connection_id,purpose,subject_id,document FROM orders_return_read_evidence WHERE id=ANY($1::uuid[])',
          [[...verification.observationRefs, ...audited]],
        );
        expect(stored.rows).toEqual([
          {
            id: readId,
            case_id: caseId,
            connection_id: connectionId,
            purpose: 'settlement',
            subject_id: actionId,
            document: {
              ...read,
              tenantId,
              caseId,
              purpose: 'settlement',
              subjectId: actionId,
            },
          },
        ]);
      });

      // The runtime role may append reads but never change or remove them.
      for (const statement of [
        'DELETE FROM orders_return_read_evidence WHERE id=$1',
        "UPDATE orders_return_read_evidence SET purpose='creation' WHERE id=$1",
      ])
        await expect(
          database.transaction(tenantId, (tx) =>
            tx.query(statement, [readId]).then(() => {}),
          ),
        ).rejects.toThrow('permission denied');

      // Another tenant sees nothing and cannot store a read against this tenant's case.
      await database.transaction(otherTenant, async (tx) => {
        expect(
          (await tx.query('SELECT * FROM orders_return_read_evidence')).rows,
        ).toEqual([]);
      });
      await expect(
        database.transaction(otherTenant, (tx) =>
          tx
            .query(
              `INSERT INTO orders_return_read_evidence(tenant_id,id,case_id,connection_id,purpose,subject_id,observed_at,document)
               VALUES($1,$2,$3,$4,'settlement',$5,now(),$6)`,
              [
                tenantId,
                randomUUID(),
                caseId,
                connectionId,
                actionId,
                { ...read, tenantId, caseId },
              ],
            )
            .then(() => {}),
        ),
      ).rejects.toThrow('row-level security');
    } finally {
      await runtime?.end();
      await db.drop();
      await admin.query(`DROP ROLE IF EXISTS "${role}"`);
      await admin.end();
    }
  }, 60_000);
});
