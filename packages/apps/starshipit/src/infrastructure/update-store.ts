import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import type { TenantContext } from '@luma/identity';
import { canonicalJson, conflict, type TenantDatabase } from '@luma/platform';
import type { ProposedAction } from '@luma/policies';

export interface UpdateRun {
  id: string;
  tenantId: string;
  connectionId: string;
  orderId: string;
  revision: string;
  observedAt: string;
  lines: { lineItemId: string; currentQuantity: number; quantity: number }[];
  authority: {
    revision: number;
    connectionId: string;
    observationId: string;
    canonicalOrderId: string;
  };
  action: ProposedAction;
}

export type StoredUpdate = {
  document: UpdateRun;
  decision_id: string | null;
  sent_at: string | null;
  closed: boolean;
  settled: boolean;
};

/** Tenant-scoped immutable previews, evidence and a fence that never reopens a dispatch. */
export function createUpdateStore(database: TenantDatabase) {
  const get = async (tenant: TenantContext, id: string) =>
    database.transaction(
      tenant.tenantId,
      async (tx) =>
        (
          await tx.query<StoredUpdate>(
            'SELECT document,decision_id,sent_at::text,closed,settled FROM starshipit_order_updates WHERE tenant_id=$1 AND id=$2',
            [tenant.tenantId, id],
          )
        ).rows[0] ?? null,
    );

  return {
    get,
    async save(tenant: TenantContext, run: UpdateRun) {
      try {
        await database.transaction(tenant.tenantId, (tx) =>
          tx.query(
            'INSERT INTO starshipit_order_updates(tenant_id,id,connection_id,order_id,revision,document) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,id) DO NOTHING',
            [
              tenant.tenantId,
              run.id,
              run.connectionId,
              run.orderId,
              run.revision,
              run,
            ],
          ),
        );
      } catch (error) {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === '23505'
        )
          throw conflict(
            'Check the existing order correction before reviewing another.',
          );
        throw error;
      }
      const saved = await get(tenant, run.id);
      if (!saved || canonicalJson(saved.document) !== canonicalJson(run))
        throw conflict('This request belongs to another correction.');

      return saved;
    },
    decision: (tenant: TenantContext, id: string, decisionId: string) =>
      database.transaction(tenant.tenantId, (tx) =>
        tx.query(
          'UPDATE starshipit_order_updates SET decision_id=$3 WHERE tenant_id=$1 AND id=$2',
          [tenant.tenantId, id, decisionId],
        ),
      ),
    /**
     * Runs `operation` while this start holds the update's start lease, so concurrent starts of
     * one update run one after another, also across processes. A start that waited then finds
     * the first start's execution instead of judging the update while that start changes it.
     * No connection is held while a start runs or waits: the lease is renewed while `operation`
     * runs and expires after a crash. Throws a conflict when another start keeps the lease for
     * longer than the wait limit.
     */
    async exclusive<T>(
      tenant: TenantContext,
      id: string,
      operation: () => Promise<T>,
      limits: { leaseMs?: number; waitMs?: number; pollMs?: number } = {},
    ) {
      const leaseMs = limits.leaseMs ?? 30_000;
      const token = randomUUID();
      const claim = () =>
        database.transaction(
          tenant.tenantId,
          async (tx) =>
            (
              await tx.query(
                "UPDATE starshipit_order_updates SET start_token=$3,start_lease_until=now()+$4*interval '1 millisecond' WHERE tenant_id=$1 AND id=$2 AND (start_lease_until IS NULL OR start_lease_until<=now()) RETURNING id",
                [tenant.tenantId, id, token, leaseMs],
              )
            ).rowCount === 1,
        );
      const deadline = Date.now() + (limits.waitMs ?? 60_000);
      while (!(await claim())) {
        if (Date.now() >= deadline)
          throw conflict(
            'This correction is still being sent. Check it again shortly.',
          );
        await delay(limits.pollMs ?? 250);
      }

      // A failed renewal lets the lease lapse; the send fence still prevents a second send.
      const renewal = setInterval(() => {
        database
          .transaction(tenant.tenantId, (tx) =>
            tx.query(
              "UPDATE starshipit_order_updates SET start_lease_until=now()+$4*interval '1 millisecond' WHERE tenant_id=$1 AND id=$2 AND start_token=$3",
              [tenant.tenantId, id, token, leaseMs],
            ),
          )
          .catch(() => undefined);
      }, leaseMs / 3);
      try {
        return await operation();
      } finally {
        clearInterval(renewal);
        await database
          .transaction(tenant.tenantId, (tx) =>
            tx.query(
              'UPDATE starshipit_order_updates SET start_token=NULL,start_lease_until=NULL WHERE tenant_id=$1 AND id=$2 AND start_token=$3',
              [tenant.tenantId, id, token],
            ),
          )
          .catch(() => undefined);
      }
    },
    /** Mark before sending; concurrent starts and restarted workers cannot send twice. */
    send: (tenant: TenantContext, id: string) =>
      database.transaction(
        tenant.tenantId,
        async (tx) =>
          (
            await tx.query(
              'UPDATE starshipit_order_updates SET sent_at=now() WHERE tenant_id=$1 AND id=$2 AND sent_at IS NULL AND NOT closed RETURNING id',
              [tenant.tenantId, id],
            )
          ).rowCount === 1,
      ),
    /** Close an unsent operation before reconciliation, fencing a delayed dispatch. */
    close: (tenant: TenantContext, id: string) =>
      database.transaction(tenant.tenantId, (tx) =>
        tx.query(
          'UPDATE starshipit_order_updates SET closed=true WHERE tenant_id=$1 AND id=$2 AND NOT closed',
          [tenant.tenantId, id],
        ),
      ),
    settle: (tenant: TenantContext, id: string) =>
      database.transaction(tenant.tenantId, (tx) =>
        tx.query(
          'UPDATE starshipit_order_updates SET settled=true,closed=true WHERE tenant_id=$1 AND id=$2 AND NOT settled',
          [tenant.tenantId, id],
        ),
      ),
    closePreview: (tenant: TenantContext, id: string) =>
      database.transaction(tenant.tenantId, (tx) =>
        tx.query(
          'UPDATE starshipit_order_updates SET settled=true,closed=true WHERE tenant_id=$1 AND id=$2 AND sent_at IS NULL AND NOT settled',
          [tenant.tenantId, id],
        ),
      ),
    record: (
      tenant: TenantContext,
      id: string,
      connectionId: string,
      observedAt: string,
      document: unknown,
    ) =>
      database.transaction(tenant.tenantId, (tx) =>
        tx.query(
          'INSERT INTO starshipit_order_update_evidence(tenant_id,id,connection_id,observed_at,document) VALUES($1,$2,$3,$4,$5)',
          [tenant.tenantId, id, connectionId, observedAt, document],
        ),
      ),
    hint: (tenant: TenantContext, connectionId: string, id: string) =>
      database.transaction(tenant.tenantId, (tx) =>
        tx.query(
          'INSERT INTO connector_refresh_hints(tenant_id,connection_id,event_key,capabilities,reconcile) VALUES($1,$2,$3,$4,false) ON CONFLICT DO NOTHING',
          [
            tenant.tenantId,
            connectionId,
            createHash('sha256')
              .update(`starshipit-update:${id}`)
              .digest('hex'),
            ['orders.read', 'fulfillment.read'],
          ],
        ),
      ),
    recent: (tenant: TenantContext, connectionId: string, orderId: string) =>
      database.transaction(
        tenant.tenantId,
        async (tx) =>
          (
            await tx.query<StoredUpdate>(
              'SELECT document,decision_id,sent_at::text,closed,settled FROM starshipit_order_updates WHERE tenant_id=$1 AND connection_id=$2 AND order_id=$3 ORDER BY created_at DESC LIMIT 10',
              [tenant.tenantId, connectionId, orderId],
            )
          ).rows,
      ),
    open: (tenant: TenantContext) =>
      database.transaction(
        tenant.tenantId,
        async (tx) =>
          (
            await tx.query<StoredUpdate>(
              "SELECT document,decision_id,sent_at::text,closed,settled FROM starshipit_order_updates WHERE tenant_id=$1 AND NOT settled AND (sent_at IS NOT NULL OR (document->'action'->>'expiresAt')::timestamptz>now()) ORDER BY created_at DESC LIMIT 50",
              [tenant.tenantId],
            )
          ).rows,
      ),
  };
}
