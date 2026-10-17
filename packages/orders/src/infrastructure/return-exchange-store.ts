import type { AuditLog } from '@luma/audit';
import type { TenantDatabase } from '@luma/platform';

import type {
  ExchangeChoice,
  ReturnExchangeStore,
} from '../application/return-exchanges.js';
import type { ReturnAction } from '../domain/return-actions.js';
import type { ReturnCase } from '../domain/return-cases.js';
import type {
  ExchangeStep,
  ReturnExchange,
} from '../domain/return-exchanges.js';
import { insertReturnRead, insertReturnWriteReceipt } from './return-reads.js';

/** Persists immutable provider plans and one case operation behind forced tenant RLS. */
export function createReturnExchangeStore(
  db: TenantDatabase,
  audit: (db: TenantDatabase) => AuditLog,
): ReturnExchangeStore {
  return {
    transaction: (tenantId, fn, options) =>
      db.transaction(
        tenantId,
        async (tx) => {
          const log = audit({
            transaction: async (_tenant, operation) => operation(tx),
          });

          return fn({
            read: async (caseId) =>
              (
                await tx.query<{ document: ReturnCase }>(
                  'SELECT document FROM orders_return_cases WHERE tenant_id=$1 AND id=$2',
                  [tenantId, caseId],
                )
              ).rows[0]?.document ?? null,
            lock: async (caseId) => {
              const found = (
                await tx.query<{ document: ReturnCase }>(
                  'SELECT document FROM orders_return_cases WHERE tenant_id=$1 AND id=$2',
                  [tenantId, caseId],
                )
              ).rows[0]?.document;
              if (!found) return null;
              await tx.query(
                'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
                [`orders-return-cases:${tenantId}:${found.orderId}`],
              );

              return (
                (
                  await tx.query<{ document: ReturnCase }>(
                    'SELECT document FROM orders_return_cases WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
                    [tenantId, caseId],
                  )
                ).rows[0]?.document ?? null
              );
            },
            root: async (caseId) =>
              (
                await tx.query<{ document: ReturnExchange }>(
                  'SELECT document FROM orders_return_exchanges WHERE tenant_id=$1 AND case_id=$2',
                  [tenantId, caseId],
                )
              ).rows[0]?.document ?? null,
            saveRoot: async (value) => {
              await tx.query(
                'INSERT INTO orders_return_exchanges(tenant_id,id,case_id,document) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,id) DO UPDATE SET document=EXCLUDED.document',
                [tenantId, value.id, value.caseId, value],
              );
            },
            get: async (id) =>
              (
                await tx.query<{ document: ExchangeStep }>(
                  'SELECT document FROM orders_return_exchange_steps WHERE tenant_id=$1 AND id=$2',
                  [tenantId, id],
                )
              ).rows[0]?.document ?? null,
            list: async (caseId) =>
              (
                await tx.query<{ document: ExchangeStep }>(
                  'SELECT document FROM orders_return_exchange_steps WHERE tenant_id=$1 AND case_id=$2 ORDER BY requested_at,id',
                  [tenantId, caseId],
                )
              ).rows.map((r) => r.document),
            live: async (requestedBy) =>
              (
                await tx.query<{ document: ExchangeStep }>(
                  `SELECT document FROM orders_return_exchange_steps WHERE tenant_id=$1 AND document->>'requestedBy'=$2
                    AND state IN ('approval_required','approved','sending','uncertain')
                  ORDER BY requested_at,id LIMIT 100`,
                  [tenantId, requestedBy],
                )
              ).rows.map((r) => r.document),
            insert: async (value) => {
              await tx.query(
                'INSERT INTO orders_return_exchange_steps(tenant_id,id,operation_id,case_id,kind,marker,state,sent,document,requested_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
                [
                  tenantId,
                  value.id,
                  value.operationId,
                  value.caseId,
                  value.plan.kind,
                  'marker' in value.plan
                    ? value.plan.marker
                    : value.operationId,
                  value.state,
                  value.sent,
                  value,
                  value.requestedAt,
                ],
              );
            },
            save: async (value) => {
              await tx.query(
                'UPDATE orders_return_exchange_steps SET state=$3,sent=$4,document=$5 WHERE tenant_id=$1 AND id=$2',
                [tenantId, value.id, value.state, value.sent, value],
              );
            },
            choices: async (value) => {
              const rows = await tx.query<
                ExchangeChoice & Record<string, unknown>
              >(
                `
      SELECT shop.id::text || ':' || wawi.id::text AS id,shop.canonical_id AS "skuId",
      ARRAY[shop.id::text,wawi.id::text] AS "mappingIds",
      jsonb_build_object('externalId',shop.external_id,'scopeKey',shop.scope_key) AS "inventoryItem",
      wawi.connection_id AS "wawiConnectionId",jsonb_build_object('externalId',wawi.external_id,'scopeKey',wawi.scope_key) AS item,
      COALESCE(w.document->>'label','Wawi') AS label
      FROM connector_source_mappings shop JOIN connector_source_mappings wawi
      ON wawi.tenant_id=shop.tenant_id AND wawi.resource='sku' AND wawi.canonical_id=shop.canonical_id
      JOIN connector_installations s ON s.tenant_id=shop.tenant_id AND s.id=shop.connection_id
      JOIN connector_installations w ON w.tenant_id=wawi.tenant_id AND w.id=wawi.connection_id
      WHERE shop.tenant_id=$1 AND shop.connection_id=$2 AND shop.resource='sku'
      AND s.document->>'provider'='shopify' AND w.document->>'provider'='jtl'
      AND s.document->>'status'='active' AND w.document->>'status'='active'
      AND s.document->'granted' ? 'returns.exchange.request' AND s.document->'permissions' ? 'returns.exchange.request'
      AND s.document->'granted' ? 'returns.exchange.options.read' AND s.document->'permissions' ? 'returns.exchange.options.read'
      AND w.document->'granted' ? 'inventory.read' AND w.document->'permissions' ? 'inventory.read'
      AND EXISTS(SELECT 1 FROM workspace_apps a WHERE a.tenant_id=s.tenant_id AND a.app_id=s.document->>'appId' AND a.status='installed' AND a.version=(s.document->>'appInstallationVersion')::int)
      AND EXISTS(SELECT 1 FROM workspace_apps a WHERE a.tenant_id=w.tenant_id AND a.app_id=w.document->>'appId' AND a.status='installed' AND a.version=(w.document->>'appInstallationVersion')::int)
      AND (SELECT count(*) FROM connector_source_mappings m WHERE m.tenant_id=shop.tenant_id AND m.connection_id=shop.connection_id AND m.resource='sku' AND m.canonical_id=shop.canonical_id)=1
      AND (SELECT count(*) FROM connector_source_mappings m WHERE m.tenant_id=wawi.tenant_id AND m.connection_id=wawi.connection_id AND m.resource='sku' AND m.canonical_id=wawi.canonical_id)=1
      ORDER BY shop.canonical_id,wawi.connection_id LIMIT 51`,
                [tenantId, value.connectionId],
              );

              return rows.rows.length > 50 ? [] : rows.rows;
            },
            refundFallback: async (value, event) => {
              const actorId = event.actorId,
                at = event.occurredAt;
              if (!value.proposal)
                throw new Error('Exchange proposal required');
              const refund = (
                await tx.query(
                  "SELECT id FROM orders_return_actions WHERE tenant_id=$1 AND case_id=$2 AND kind='refund' AND (sent OR state IN ('approval_required','approved','sending'))",
                  [tenantId, value.id],
                )
              ).rows;
              if (refund.length)
                throw new Error('A refund already owns this case');
              const next: ReturnCase = {
                ...value,
                proposal: {
                  ...value.proposal,
                  kind: 'refund',
                  by: actorId,
                  at,
                },
                sourceReturnId: null,
                revision: value.revision + 1,
                updatedAt: at,
              };
              await tx.query(
                'UPDATE orders_return_cases SET source_return_id=NULL,revision=$3,document=$4,updated_at=$5 WHERE tenant_id=$1 AND id=$2',
                [tenantId, value.id, next.revision, next, at],
              );
              await tx.query(
                'INSERT INTO orders_return_case_events(tenant_id,id,case_id,command_id,digest,kind,actor_id,revision,document,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
                [
                  tenantId,
                  event.id,
                  event.caseId,
                  event.commandId,
                  event.digest,
                  event.kind,
                  event.actorId,
                  event.revision,
                  event,
                  event.occurredAt,
                ],
              );
            },
            stockActions: async (caseId) =>
              (
                await tx.query<{ document: ReturnAction }>(
                  "SELECT document FROM orders_return_actions WHERE tenant_id=$1 AND case_id=$2 AND kind='restock' AND sent ORDER BY requested_at,id LIMIT 101",
                  [tenantId, caseId],
                )
              ).rows.map((r) => r.document),
            finishCase: async (value, event) => {
              const changed = await tx.query(
                "UPDATE orders_return_cases SET state=$3,revision=$4,document=$5,updated_at=$6 WHERE tenant_id=$1 AND id=$2 AND revision=$4-1 AND state IN ('open','completed') AND document->'receipt'=$5::jsonb->'receipt' AND document->'inspection'=$5::jsonb->'inspection' AND document->'proposal'=$5::jsonb->'proposal'",
                [
                  tenantId,
                  value.id,
                  value.state,
                  value.revision,
                  value,
                  value.updatedAt,
                ],
              );
              if (changed.rowCount !== 1)
                throw new Error('Return case changed during consistency check');
              if (value.state === 'completed')
                await tx.query(
                  "UPDATE orders_return_waits w SET state='verified',document=w.document || jsonb_build_object('state','verified','updatedAt',$3::text,'endedAt',$3::text,'observedAt',$3::text,'evidenceRefs',e.document->'completion'->'evidenceRefs') FROM orders_return_exchanges e WHERE w.tenant_id=$1 AND w.case_id=$2 AND w.state IN ('waiting','escalated') AND e.tenant_id=w.tenant_id AND e.case_id=w.case_id AND e.document->'completion'->>'state'='verified'",
                  [tenantId, value.id, value.updatedAt],
                );
              await tx.query(
                'INSERT INTO orders_return_case_events(tenant_id,id,case_id,command_id,digest,kind,actor_id,revision,document,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
                [
                  tenantId,
                  event.id,
                  event.caseId,
                  event.commandId,
                  event.digest,
                  event.kind,
                  event.actorId,
                  event.revision,
                  event,
                  event.occurredAt,
                ],
              );
            },
            audit: (entry) => log.append(entry),
            recordRead: (evidence) => insertReturnRead(tx, tenantId, evidence),
            recordWriteReceipt: (receipt) =>
              insertReturnWriteReceipt(tx, tenantId, receipt),
          });
        },
        options,
      ),
  };
}
