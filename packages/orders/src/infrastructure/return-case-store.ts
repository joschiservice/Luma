import type { AuditLog } from '@luma/audit';
import type { TenantDatabase } from '@luma/platform';

import type { CommerceData, ReturnData } from '../application/projections.js';
import type {
  OrderSource,
  Person,
  ReturnCaseEvent,
  ReturnCaseStore,
  SourceReturnRecord,
} from '../application/return-cases.js';
import type { ReturnCase } from '../domain/return-cases.js';
import type { ExchangeConsistencyReport } from '../domain/return-consistency.js';
import type { ReturnCreation, SourceRef } from '../domain/return-creations.js';

type OrderData = Extract<CommerceData, { type: 'order' }>;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// A retired order pointer redirects to the order it was linked into.
const currentOrder = `COALESCE((SELECT target_entity_id FROM orders_entity_redirects
  WHERE tenant_id=$1 AND entity_id=$2::uuid),$2::uuid)`;

const storeReturnSql = `SELECT r.entity_id,r.connection_id,r.order_id,r.name,r.status,(SELECT CASE WHEN count(*)=1 THEN jsonb_build_object('externalId',min(m.external_id),'scopeKey',min(m.scope_key)) END FROM connector_source_mappings m WHERE m.tenant_id=r.tenant_id AND m.connection_id=r.connection_id AND m.resource='return' AND m.canonical_id=r.entity_id) AS source,s.document->'data'->'lines' AS lines
  FROM orders_returns r JOIN orders_snapshots s ON s.tenant_id=r.tenant_id AND s.id=r.snapshot_id
  WHERE r.tenant_id=$1 AND r.kind='return' AND NOT r.deleted`;

interface StoreReturnRow extends Record<string, unknown> {
  source: SourceRef | null;
  entity_id: string;
  connection_id: string;
  order_id: string;
  name: string | null;
  status: ReturnData['status'];
  lines: ReturnData['lines'];
}

const storeReturn = (row: StoreReturnRow): SourceReturnRecord => ({
  ...(row.source ? { source: row.source } : {}),
  entityId: row.entity_id,
  connectionId: row.connection_id,
  orderId: row.order_id,
  name: row.name,
  status: row.status,
  lines: row.lines.map((line) => ({
    orderLineId: line.orderLineId,
    quantity: line.quantity,
  })),
});

/**
 * Persists return cases, their history and creation requests with audit evidence in one
 * tenant transaction. Reads canonical orders, store returns and source mappings without
 * changing them.
 */
export function createReturnCaseStore(
  db: TenantDatabase,
  audit: (db: TenantDatabase) => AuditLog,
): ReturnCaseStore {
  return {
    transaction: (tenantId, _write, operation) =>
      db.transaction(tenantId, async (tx) => {
        const log = audit({ transaction: async (_tenant, fn) => fn(tx) });
        const documents = async <T>(sql: string, params: unknown[]) =>
          (await tx.query<{ document: T }>(sql, params)).rows.map(
            (r) => r.document,
          );

        return operation({
          findCases: async (query) => {
            const q = query.q.trim();
            const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
            const rows = await tx.query<{
              document: ReturnCase;
              orderNumber: string | null;
              creation: ReturnCreation | null;
              assignment: ReturnCaseEvent | null;
              completion: ExchangeConsistencyReport | null;
            }>(
              `SELECT c.document,ex.document->'completion' AS completion,cr.document AS creation,ce.document AS assignment,s.document->'data'->>'displayNumber' AS "orderNumber"
              FROM orders_return_cases c
              LEFT JOIN orders_return_exchanges ex ON ex.tenant_id=c.tenant_id AND ex.case_id=c.id
              LEFT JOIN orders_entity_redirects red ON red.tenant_id=c.tenant_id AND red.entity_id=c.order_id
              LEFT JOIN LATERAL (SELECT document FROM orders_return_creations WHERE tenant_id=c.tenant_id AND case_id=c.id ORDER BY created_at DESC,id DESC LIMIT 1) cr ON true
              LEFT JOIN LATERAL (SELECT document FROM orders_return_case_events WHERE tenant_id=c.tenant_id AND case_id=c.id AND kind='assigned' ORDER BY occurred_at DESC,revision DESC LIMIT 1) ce ON true
              LEFT JOIN orders_projections p ON p.tenant_id=c.tenant_id AND p.entity_id=COALESCE(red.target_entity_id,c.order_id) AND p.connection_id=c.connection_id
              LEFT JOIN orders_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id
              WHERE c.tenant_id=$1 AND (NOT $2::boolean OR c.state='open')
              AND ($3='' OR c.id::text=lower($3) OR c.order_id::text=lower($3) OR s.document->'data'->>'displayNumber' ILIKE $4
                OR EXISTS (SELECT 1 FROM jsonb_array_elements(c.document->'lines') l WHERE l->>'sku' ILIKE $4 OR l->>'title' ILIKE $4)
                OR EXISTS (SELECT 1 FROM connector_source_mappings m WHERE m.tenant_id=c.tenant_id AND m.connection_id=c.connection_id
                  AND m.canonical_id IN (COALESCE(red.target_entity_id,c.order_id),c.source_return_id) AND m.resource IN ('order','return') AND m.external_id ILIKE $4))
              AND ($5::uuid IS NULL OR EXISTS (SELECT 1 FROM customer_profiles cp JOIN customer_orders co ON co.tenant_id=cp.tenant_id AND co.connection_id=cp.connection_id AND co.customer_external_id=cp.external_id
                JOIN connector_source_mappings m ON m.tenant_id=co.tenant_id AND m.connection_id=co.connection_id AND m.resource='order' AND m.external_id=co.order_external_id AND m.scope_key=co.order_scope_key
                WHERE cp.tenant_id=c.tenant_id AND cp.id=$5 AND m.canonical_id=COALESCE(red.target_entity_id,c.order_id)))
              AND ($6::timestamptz IS NULL OR (c.updated_at,c.id)<($6,$7::uuid))
              ORDER BY c.updated_at DESC,c.id DESC LIMIT $8`,
              [
                tenantId,
                !!query.openOnly,
                q,
                pattern,
                query.customerId ?? null,
                query.after?.at ?? null,
                query.after?.id ?? null,
                query.limit,
              ],
            );

            return rows.rows.map((row) => ({
              value: row.document,
              orderNumber: row.orderNumber,
              creation: row.creation,
              assignment: row.assignment,
              completion: row.completion,
            }));
          },
          lockOrder: async (orderId) => {
            await tx.query(
              'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
              [`orders-return-cases:${tenantId}:${orderId}`],
            );
          },
          orderSources: async (orderId) => {
            const rows = await tx.query<{
              connection_id: string;
              data: OrderData;
            }>(
              `SELECT p.connection_id,s.document->'data' AS data FROM orders_projections p
               JOIN orders_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id
               WHERE p.tenant_id=$1 AND p.entity_id=${currentOrder} AND s.kind='order'
                AND COALESCE((s.document->>'deleted')::boolean,false)=false
               ORDER BY p.connection_id`,
              [tenantId, orderId],
            );

            return rows.rows.map((row): OrderSource => ({
              connectionId: row.connection_id,
              displayNumber: row.data.displayNumber,
              lines: row.data.lines.map((line) => ({
                id: line.id,
                quantity: line.quantity,
                cancelledQuantity: line.cancelledQuantity,
                unit: line.unit,
                title: line.title ?? null,
                sku: line.skuCode ?? null,
              })),
            }));
          },
          storeReturns: async (orderId) =>
            (
              await tx.query<StoreReturnRow>(
                `${storeReturnSql} AND r.order_id=${currentOrder} ORDER BY r.requested_at NULLS LAST,r.entity_id`,
                [tenantId, orderId],
              )
            ).rows.map(storeReturn),
          sourceReturn: async (entityId) => {
            const row = (
              await tx.query<StoreReturnRow>(
                `${storeReturnSql} AND r.entity_id=$2 ORDER BY r.connection_id LIMIT 1`,
                [tenantId, entityId],
              )
            ).rows[0];

            return row ? storeReturn(row) : null;
          },
          cases: (orderId) =>
            documents<ReturnCase>(
              `SELECT document FROM orders_return_cases WHERE tenant_id=$1
               AND (order_id=${currentOrder} OR order_id IN (SELECT entity_id FROM orders_entity_redirects
                WHERE tenant_id=$1 AND target_entity_id=${currentOrder}))
               ORDER BY opened_at,id`,
              [tenantId, orderId],
            ),
          case: async (id) =>
            (
              await documents<ReturnCase>(
                'SELECT document FROM orders_return_cases WHERE tenant_id=$1 AND id=$2',
                [tenantId, id],
              )
            )[0] ?? null,
          insertCase: async (value) => {
            await tx.query(
              `INSERT INTO orders_return_cases(tenant_id,id,order_id,connection_id,source_return_id,state,revision,document,opened_at,updated_at)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
              [
                tenantId,
                value.id,
                value.orderId,
                value.connectionId,
                value.sourceReturnId,
                value.state,
                value.revision,
                value,
                value.openedAt,
                value.updatedAt,
              ],
            );
          },
          saveCase: async (value) => {
            const changed =
              (
                await tx.query(
                  `UPDATE orders_return_cases SET state=$3,revision=$4,document=$5,updated_at=$6
                 WHERE tenant_id=$1 AND id=$2 AND revision=$4-1
                  AND ((NOT EXISTS(SELECT 1 FROM orders_return_actions a WHERE a.tenant_id=$1 AND a.case_id=$2 AND a.sent)
                    AND NOT EXISTS(SELECT 1 FROM orders_return_exchange_steps e WHERE e.tenant_id=$1 AND e.case_id=$2 AND e.sent))
                    OR (state=$3 AND document->'receipt'=$5::jsonb->'receipt' AND document->'inspection'=$5::jsonb->'inspection' AND document->'proposal'=$5::jsonb->'proposal'))`,
                  [
                    tenantId,
                    value.id,
                    value.state,
                    value.revision,
                    value,
                    value.updatedAt,
                  ],
                )
              ).rowCount === 1;
            if (changed)
              await tx.query(
                "UPDATE orders_return_exchanges SET document=document || jsonb_build_object('ownerId',$3::text,'revision',(document->>'revision')::int+1,'updatedAt',$4::text) WHERE tenant_id=$1 AND case_id=$2 AND document->>'ownerId' IS DISTINCT FROM $3",
                [
                  tenantId,
                  value.id,
                  value.assigneeId ?? value.openedBy,
                  value.updatedAt,
                ],
              );

            return changed;
          },
          events: (caseId) =>
            documents<ReturnCaseEvent>(
              'SELECT document FROM orders_return_case_events WHERE tenant_id=$1 AND case_id=$2 ORDER BY occurred_at,revision,id',
              [tenantId, caseId],
            ),
          event: async (commandId) =>
            (
              await documents<ReturnCaseEvent>(
                'SELECT document FROM orders_return_case_events WHERE tenant_id=$1 AND command_id=$2',
                [tenantId, commandId],
              )
            )[0] ?? null,
          insertEvent: async (event) => {
            await tx.query(
              `INSERT INTO orders_return_case_events(tenant_id,id,case_id,command_id,digest,kind,actor_id,revision,document,occurred_at)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
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
          creations: (caseId) =>
            documents<ReturnCreation>(
              'SELECT document FROM orders_return_creations WHERE tenant_id=$1 AND case_id=$2 ORDER BY created_at DESC,id DESC',
              [tenantId, caseId],
            ),
          creation: async (id) =>
            (
              await documents<ReturnCreation>(
                'SELECT document FROM orders_return_creations WHERE tenant_id=$1 AND id=$2',
                [tenantId, id],
              )
            )[0] ?? null,
          insertCreation: async (value) => {
            await tx.query(
              `INSERT INTO orders_return_creations(tenant_id,id,case_id,connection_id,state,principal_id,document,created_at)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
              [
                tenantId,
                value.id,
                value.caseId,
                value.connectionId,
                value.state,
                value.requestedBy,
                value,
                value.requestedAt,
              ],
            );
          },
          saveCreation: async (value) => {
            await tx.query(
              'UPDATE orders_return_creations SET state=$3,document=$4 WHERE tenant_id=$1 AND id=$2',
              [tenantId, value.id, value.state, value],
            );
          },
          sourceIds: async (connectionId, orderId, orderLineIds) => {
            const rows = (
              await tx.query<{
                resource: 'order' | 'order_line';
                canonical_id: string;
                external_id: string;
                scope_key: string;
              }>(
                `SELECT resource,canonical_id,external_id,scope_key FROM connector_source_mappings
                 WHERE tenant_id=$1 AND connection_id=$2
                  AND ((resource='order' AND canonical_id=${currentOrder.replaceAll('$2', '$3')})
                   OR (resource='order_line' AND canonical_id=ANY($4::uuid[])))
                 ORDER BY resource,canonical_id,external_id`,
                [tenantId, connectionId, orderId, orderLineIds],
              )
            ).rows;
            const ref = (row: (typeof rows)[number]): SourceRef => ({
              externalId: row.external_id,
              scopeKey: row.scope_key,
            });
            // An entity with more than one source identity on the connection is ambiguous.
            const single = (matches: typeof rows) =>
              matches.length === 1 ? ref(matches[0]!) : null;
            const lines = new Map<string, SourceRef>();
            for (const id of orderLineIds) {
              const found = single(
                rows.filter(
                  (r) => r.resource === 'order_line' && r.canonical_id === id,
                ),
              );
              if (found) lines.set(id, found);
            }

            return {
              order: single(rows.filter((r) => r.resource === 'order')),
              lines,
            };
          },
          people: async (ids) => {
            const unique = [...new Set(ids.filter((id) => uuid.test(id)))];
            const rows = unique.length
              ? (
                  await tx.query<{
                    id: string;
                    name: string;
                    is_member: boolean;
                  }>(
                    'SELECT user_id::text AS id,name,is_member FROM workspace_people WHERE tenant_id=$1 AND user_id=ANY($2::uuid[])',
                    [tenantId, unique],
                  )
                ).rows
              : [];

            return new Map(
              rows.map((row): [string, Person] => [
                row.id,
                { id: row.id, name: row.name, member: row.is_member },
              ]),
            );
          },
          audit: (entry) => log.append(entry),
        });
      }),
  };
}
