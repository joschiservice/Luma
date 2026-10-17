import type {
  StockProtectionIncident,
  StockProtectionSettings,
} from '@luma/api-contract';
import { stockProtectionIncidentSchema } from '@luma/api-contract';
import type { TenantContext } from '@luma/identity';
import {
  canonicalJson,
  conflict,
  notFound,
  type TenantDatabase,
} from '@luma/platform';
import type { ProposedAction } from '@luma/policies';

import type { CorrectionSnapshot } from '../domain/inventory-correction.js';

export interface ProtectionAction {
  id: string;
  incidentId: string;
  holdId: string;
  operation: 'hold' | 'tighten' | 'release';
  key: string;
  target: {
    positionId: string;
    connectionId: string;
    sourceConnectionId: string;
  };
  before: CorrectionSnapshot;
  quantity: number;
  policyRevision: number;
  action: ProposedAction;
}

export interface ProtectionRecord {
  view: StockProtectionIncident;
  settings: StockProtectionSettings;
  principalId: string;
  /** The most recent accounting boundary for unit-hours. */
  accountedAt: string;
  cursor?: number;
  releaseHoldIds?: string[];
}

/** Persists incident ownership and immutable dispatch identities. Mutations merge under a row lock. */
export function createProtectionStore(database: TenantDatabase) {
  const get = (context: TenantContext, id: string) =>
    database.transaction(
      context.tenantId,
      async (tx) =>
        (
          await tx.query<{ document: ProtectionRecord }>(
            'SELECT document FROM shopify_stock_protection_incidents WHERE tenant_id=$1 AND id=$2',
            [context.tenantId, id],
          )
        ).rows[0]?.document ?? null,
    );

  return {
    get,
    /** Reads discovery identities without loading per-SKU histories. */
    heads: (context: TenantContext) =>
      database.transaction(
        context.tenantId,
        async (tx) =>
          (
            await tx.query<{ id: string; principalId: string; state: string }>(
              `SELECT id,principal_id AS "principalId",document->'view'->>'state' AS state FROM shopify_stock_protection_incidents WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 1000`,
              [context.tenantId],
            )
          ).rows,
      ),
    /** Computes summaries in storage and returns only the requested page of positions. */
    publicView: (
      context: TenantContext,
      filter: {
        incidentId?: string | undefined;
        positionId?: string | undefined;
        skuId?: string | undefined;
        offset: number;
        limit: number;
      },
    ) =>
      database.transaction(context.tenantId, async (tx) =>
        (
          await tx.query<{ document: StockProtectionIncident }>(
            `
      SELECT ((i.document->'view')-'positions') || jsonb_build_object(
       'requesterId',i.principal_id,'positionCount',count(chosen.p),'heldCount',count(*) FILTER(WHERE p->>'startedAt' IS NOT NULL AND p->>'endedAt' IS NULL),
       'protectedCount',count(*) FILTER(WHERE p->>'startedAt' IS NOT NULL),
       'exposedSkus',count(*) FILTER(WHERE p->>'startedAt' IS NOT NULL AND (p->>'exposedUnits')::numeric>0),
       'uncertainCount',count(*) FILTER(WHERE p->>'status'='unknown' AND p->>'actionId' IS NOT NULL AND p->>'endedAt' IS NULL),
       'pendingCount',count(*) FILTER(WHERE p->>'status'='pending'),
       'unitHours',COALESCE(sum((p->>'unitMilliseconds')::numeric),0)/3600000,
       'exposedUnits',COALESCE(sum((p->>'exposedUnits')::numeric),0),
       'positionsTruncated',count(chosen.p)>$5::int+$6::int,
       'positions',COALESCE(jsonb_agg(p ORDER BY rn) FILTER(WHERE rn>$5::int AND rn<=$5::int+$6::int),'[]'::jsonb)) AS document
      FROM shopify_stock_protection_incidents i LEFT JOIN LATERAL (
       SELECT p,row_number() OVER(ORDER BY ordinal) AS rn FROM jsonb_array_elements(i.document->'view'->'positions') WITH ORDINALITY AS positions(p,ordinal)
       WHERE ($3::text IS NULL OR p->>'positionId'=$3) AND ($4::text IS NULL OR p->>'skuId'=$4)
      ) chosen ON true
      WHERE i.tenant_id=$1 AND ($2::uuid IS NULL OR i.id=$2) AND ($2::uuid IS NOT NULL OR i.document->'view'->>'state'<>'released' OR i.created_at>now()-interval '7 days')
      GROUP BY i.tenant_id,i.id HAVING ($3::text IS NULL AND $4::text IS NULL) OR count(chosen.p)>0 ORDER BY i.created_at DESC LIMIT 100`,
            [
              context.tenantId,
              filter.incidentId ?? null,
              filter.positionId ?? null,
              filter.skuId ?? null,
              filter.offset,
              filter.limit || (filter.positionId || filter.skuId ? 200 : 0),
            ],
          )
        ).rows.map((row) => stockProtectionIncidentSchema.parse(row.document)),
      ),
    list: (context: TenantContext) =>
      database.transaction(context.tenantId, async (tx) =>
        (
          await tx.query<{ document: ProtectionRecord }>(
            `SELECT document FROM shopify_stock_protection_incidents WHERE tenant_id=$1 AND (document->'view'->>'state'<>'released' OR created_at>now()-interval '7 days') ORDER BY created_at DESC,id LIMIT 100`,
            [context.tenantId],
          )
        ).rows.map((row) => row.document),
      ),
    async create(context: TenantContext, record: ProtectionRecord) {
      stockProtectionIncidentSchema.parse(record.view);
      await database.transaction(context.tenantId, async (tx) => {
        await tx.query(
          'INSERT INTO shopify_stock_protection_incidents(tenant_id,id,connection_id,source_connection_id,principal_id,document) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
          [
            context.tenantId,
            record.view.id,
            record.view.connectionId,
            record.view.sourceConnectionId,
            record.principalId,
            record,
          ],
        );
      });

      return (await get(context, record.view.id))!;
    },
    update: (
      context: TenantContext,
      id: string,
      change: (record: ProtectionRecord) => void,
    ) =>
      database.transaction(context.tenantId, async (tx) => {
        const row = (
          await tx.query<{ document: ProtectionRecord }>(
            'SELECT document FROM shopify_stock_protection_incidents WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
            [context.tenantId, id],
          )
        ).rows[0];
        if (!row) throw notFound('Stock protection incident not found.');
        change(row.document);
        stockProtectionIncidentSchema.parse(row.document.view);
        await tx.query(
          'UPDATE shopify_stock_protection_incidents SET document=$3,revision=revision+1 WHERE tenant_id=$1 AND id=$2',
          [context.tenantId, id, row.document],
        );

        return row.document;
      }),
    action: (context: TenantContext, id: string) =>
      database.transaction(
        context.tenantId,
        async (tx) =>
          (
            await tx.query<{ document: ProtectionAction }>(
              'SELECT document FROM shopify_stock_protection_actions WHERE tenant_id=$1 AND id=$2',
              [context.tenantId, id],
            )
          ).rows[0]?.document ?? null,
      ),
    async saveAction(context: TenantContext, action: ProtectionAction) {
      return database.transaction(context.tenantId, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `${context.tenantId}:${action.target.connectionId}:${action.before.inventoryItemId}:${action.before.locationId}`,
        ]);
        const pending = await tx.query(
          'SELECT 1 FROM shopify_inventory_claims WHERE tenant_id=$1 AND connection_id=$2 AND target_key=$3 AND NOT settled LIMIT 1',
          [
            context.tenantId,
            action.target.connectionId,
            `${action.before.inventoryItemId}:${action.before.locationId}`,
          ],
        );
        if (pending.rowCount)
          throw conflict(
            'A stock correction owns this position. Reconcile it first.',
          );
        const owners = await tx.query(
          `SELECT 1 FROM shopify_stock_protection_incidents i CROSS JOIN LATERAL jsonb_array_elements(i.document->'view'->'positions') p WHERE i.tenant_id=$1 AND i.connection_id=$2 AND i.id<>$3 AND (p->>'positionId'=$4 OR EXISTS(SELECT 1 FROM shopify_stock_protection_actions a WHERE a.tenant_id=i.tenant_id AND a.incident_id=i.id AND a.hold_id=(p->>'id')::uuid AND a.document->'before'->>'inventoryItemId'=$5 AND a.document->'before'->>'locationId'=$6)) AND p->>'status' IN ('pending','held','tightened','releasing','unknown') LIMIT 1`,
          [
            context.tenantId,
            action.target.connectionId,
            action.incidentId,
            action.target.positionId,
            action.before.inventoryItemId,
            action.before.locationId,
          ],
        );
        if (owners.rowCount)
          throw conflict(
            'Another stock protection incident owns this position.',
          );
        await tx.query(
          'INSERT INTO shopify_stock_protection_actions(tenant_id,id,incident_id,hold_id,operation_key,document) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
          [
            context.tenantId,
            action.id,
            action.incidentId,
            action.holdId,
            action.key,
            action,
          ],
        );
        const stored = (
          await tx.query<{ document: ProtectionAction }>(
            'SELECT document FROM shopify_stock_protection_actions WHERE tenant_id=$1 AND id=$2',
            [context.tenantId, action.id],
          )
        ).rows[0]?.document;
        if (
          !stored ||
          canonicalJson(stored.action) !== canonicalJson(action.action)
        )
          throw conflict(
            'This stock protection action already has immutable intent.',
          );

        return stored;
      });
    },
    /** Queues one notification per incident transition; delivery is independently retryable. */
    event: (
      context: TenantContext,
      id: string,
      incidentId: string,
      kind: string,
    ) =>
      database.transaction(context.tenantId, async (tx) => {
        await tx.query(
          'INSERT INTO shopify_stock_protection_events(tenant_id,id,incident_id,kind,document) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
          [context.tenantId, id, incidentId, kind, { incidentId, kind }],
        );
      }),
  };
}
