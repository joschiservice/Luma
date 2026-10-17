import { randomUUID } from 'node:crypto';

import { createAuditLog } from '@luma/audit/composition';
import { PermissionSet } from '@luma/identity';
import {
  builtInMembership,
  makeTenantContext,
} from '@luma/identity/composition';
import { createTenantDatabase } from '@luma/platform/composition';
import {
  createProcurement,
  createPurchasingTimelineActors,
  createSupplierCommitmentService,
} from '@luma/procurement/composition';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMigratedDatabase } from '../test-support/database.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)(
  'Purchasing timeline stock bookings on PostgreSQL',
  () => {
    let database: Awaited<ReturnType<typeof createMigratedDatabase>>;
    let runtime: Pool;
    let role = '';
    const tenant = randomUUID();

    function context(permissions?: string[]) {
      const membership = builtInMembership(
        { id: 'membership', organizationId: tenant, userId: 'operator' },
        'owner',
      );

      return makeTenantContext(
        { userId: 'operator', sessionId: 'session' },
        {
          id: tenant,
          name: 'Fixture',
          slug: 'fixture',
          status: 'active',
          dataRegion: 'AU',
        },
        permissions
          ? { ...membership, permissions: new PermissionSet(permissions) }
          : membership,
        randomUUID(),
      );
    }

    beforeAll(async () => {
      database = await createMigratedDatabase(databaseUrl!);
      const { owner } = database;
      const url = new URL(databaseUrl!);
      const { name } = (
        await owner.query<{ name: string }>('SELECT current_database() AS name')
      ).rows[0]!;
      url.pathname = `/${name}`;
      url.password = randomUUID();
      role = `timeline_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      url.username = role;
      // The API login's groups that the order record and its timeline read.
      await owner.query(
        `CREATE ROLE "${role}" LOGIN PASSWORD '${url.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
      );
      await owner.query(
        `GRANT luma_identity,luma_policies,luma_execution,luma_audit,luma_desk,luma_connectors,luma_adaptive,luma_inventory TO "${role}"`,
      );
      await owner.query(
        "INSERT INTO organizations(data_region,id,name,slug,status,created_at) VALUES('AU',$1,'Fixture',$2,'active',now())",
        [tenant, `timeline-${tenant}`],
      );
      runtime = new Pool({ connectionString: url.toString() });
    }, 120_000);

    afterAll(async () => {
      await runtime?.end();
      await database?.drop();
      if (role) {
        const admin = new Pool({ connectionString: databaseUrl });
        await admin.query(`DROP ROLE IF EXISTS "${role}"`);
        await admin.end();
      }
    });

    it('shows a procurement-only reader each stock booking step without its inventory details', async () => {
      const db = createTenantDatabase(runtime);
      const procurement = createProcurement(db, async (c) => c, createAuditLog);
      const commitments = createSupplierCommitmentService(db, createAuditLog, {
        purchasing: null,
        admission: null,
        refreshContext: async (c) => c,
        principal: async () => context(),
        openOrder: async () => {},
        trace: () => ({
          traceId: randomUUID(),
          spanId: randomUUID(),
          requestId: randomUUID(),
        }),
        model: { gateway: null, available: false, reason: 'Not needed' },
        timelineActors: createPurchasingTimelineActors(db),
      });
      const owner = context();
      const supplier = await procurement.createSupplier(owner, {
        id: randomUUID(),
        name: 'Acme Bags',
      });
      const order = await procurement.createOrder(owner, {
        id: randomUUID(),
        supplierId: supplier.id,
        reference: 'PO-STOCK',
        lines: [
          {
            id: randomUUID(),
            sku: 'TOTE-NAT',
            description: 'Tote',
            quantity: 20,
            unit: 'each',
          },
        ],
      });

      // A Shopify booking of the order's receipt: proposed, approved by another person,
      // executed and independently verified.
      const action = randomUUID(),
        correction = randomUUID(),
        decision = randomUUID(),
        approval = randomUUID(),
        read = randomUUID(),
        receipt = randomUUID(),
        requester = randomUUID(),
        approver = randomUUID();
      const at = '2026-10-13T12:00:00.000Z';
      const seed = await database.owner.connect();
      try {
        await seed.query('BEGIN');
        // Seed owner rows directly; their own services' constraints are covered elsewhere.
        await seed.query('SET LOCAL session_replication_role=replica');
        await seed.query(
          `INSERT INTO shopify_inventory_corrections(tenant_id,id,connection_id,position_id,revision,document)
         VALUES($1,$2,$3,$4,'1',$5)`,
          [
            tenant,
            correction,
            randomUUID(),
            randomUUID(),
            {
              id: correction,
              tenantId: tenant,
              action: {
                id: action,
                proposedBy: { id: requester },
                parameters: { locationId: 'gid://shopify/Location/1' },
              },
              target: {
                receipt: { purchaseOrderId: order.id, quantity: '19' },
                sku: 'TOTE-NAT',
              },
            },
          ],
        );
        await seed.query(
          'INSERT INTO policy_decisions(id,tenant_id,proposal_id,action_hash,document) VALUES($1,$2,$3,$4,$5)',
          [
            decision,
            tenant,
            action,
            'a'.repeat(64),
            {
              id: decision,
              tenantId: tenant,
              proposalId: action,
              outcome: 'approval_required',
              evaluatedAt: at,
              actorId: requester,
            },
          ],
        );
        await seed.query(
          'INSERT INTO policy_approvals(id,tenant_id,proposal_id,action_hash,policy_version,document) VALUES($1,$2,$3,$4,$5,$6)',
          [
            approval,
            tenant,
            action,
            'a'.repeat(64),
            'v1',
            {
              id: approval,
              tenantId: tenant,
              proposalId: action,
              decisionId: decision,
              outcome: 'approved',
              createdAt: at,
              approverId: approver,
              requesterId: requester,
            },
          ],
        );
        await seed.query(
          "INSERT INTO executed_actions(id,tenant_id,proposal_id,idempotency_key,action_hash,state,document) VALUES($1,$2,$3,$4,$5,'succeeded',$6)",
          [
            randomUUID(),
            tenant,
            action,
            `v0:${action}`,
            'a'.repeat(64),
            {
              state: 'succeeded',
              tenantId: tenant,
              proposalId: action,
              attempt: {
                startedAt: at,
                finishedAt: at,
                requestedBy: requester,
                businessOutcome: 'satisfied',
                effectEvidenceRefs: [receipt],
                verification: {
                  outcome: 'passed',
                  observationRefs: [read],
                  observedAt: at,
                },
              },
            },
          ],
        );
        await seed.query('COMMIT');
      } catch (error) {
        await seed.query('ROLLBACK');
        throw error;
      } finally {
        seed.release();
      }

      const stock = <Entry extends { kind: string }>(entries: Entry[]) =>
        entries.filter((entry) => entry.kind === 'stock_booking');

      // An inventory reader sees the booking with its quantity, requester and approver.
      const full = stock(
        (await commitments.order(owner, order.id)).timeline.entries,
      );
      expect(full.map((entry) => entry.stage).sort()).toEqual([
        'approval_required',
        'approved',
        'recorded',
        'verified',
      ]);
      expect(full).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: `stock:${correction}:requested`,
            quantity: 19,
            actorId: requester,
          }),
          expect.objectContaining({
            id: `approval:${approval}`,
            actorId: approver,
          }),
        ]),
      );
      expect(full.some((entry) => entry.restricted)).toBe(false);

      // A procurement-only reader gets the same steps, restricted, with no inventory details.
      const record = await commitments.order(
        context(['procurement.read']),
        order.id,
      );
      const restricted = stock(record.timeline.entries);
      expect(restricted.map((entry) => entry.id).sort()).toEqual(
        full.map((entry) => entry.id).sort(),
      );
      for (const entry of restricted)
        expect(entry).toEqual({
          id: entry.id,
          kind: 'stock_booking',
          stage: entry.stage,
          at: entry.at,
          actorId: null,
          reason: null,
          evidenceRefs: full.find((f) => f.id === entry.id)?.evidenceRefs,
          quantity: null,
          unit: null,
          revision: null,
          detail: null,
          source: entry.source,
          restricted: { permission: 'inventory.read' },
        });
      expect(
        restricted.find((entry) => entry.stage === 'verified')?.evidenceRefs,
      ).toEqual([read, receipt]);
      const shown = JSON.stringify(record.timeline);
      for (const hidden of [requester, approver, 'gid://shopify', '"19"'])
        expect(shown).not.toContain(hidden);
    });
  },
);
