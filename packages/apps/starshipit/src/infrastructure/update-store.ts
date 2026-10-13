import { createHash } from 'node:crypto';

import type { TenantContext } from '@luma/identity';
import { IdentityError } from '@luma/identity';
import { canonicalJson, type TenantDatabase } from '@luma/platform';
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
          throw new IdentityError(
            409,
            'CONFLICT',
            'Check the existing order correction before reviewing another.',
          );
        throw error;
      }
      const saved = await get(tenant, run.id);
      if (!saved || canonicalJson(saved.document) !== canonicalJson(run))
        throw new IdentityError(
          409,
          'CONFLICT',
          'This request belongs to another correction.',
        );

      return saved;
    },
    decision: (tenant: TenantContext, id: string, decisionId: string) =>
      database.transaction(tenant.tenantId, (tx) =>
        tx.query(
          'UPDATE starshipit_order_updates SET decision_id=$3 WHERE tenant_id=$1 AND id=$2',
          [tenant.tenantId, id, decisionId],
        ),
      ),
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
