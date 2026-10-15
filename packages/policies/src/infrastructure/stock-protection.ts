import type { TenantContext } from '@luma/identity';
import {
  IdentityError,
  requireChangesAllowed,
  requirePermission,
} from '@luma/identity';
import { canonicalJson, type TenantDatabase } from '@luma/platform';

import {
  admitsStockProtection,
  type StockProtectionConsent,
} from '../domain/stock-protection.js';

/** Owns explicit stock-protection consent; revisions share the execution epoch fence. */
export function createStockProtectionConsent(
  database: TenantDatabase,
  parse: (input: unknown) => StockProtectionConsent,
) {
  return {
    list: (context: TenantContext) =>
      database.transaction(context.tenantId, async (tx) =>
        (
          await tx.query<{ document: StockProtectionConsent }>(
            'SELECT document FROM stock_protection_policies WHERE tenant_id=$1 ORDER BY connection_id,source_connection_id',
            [context.tenantId],
          )
        ).rows.map((row) => parse(row.document)),
      ),
    principal: (
      context: TenantContext,
      connectionId: string,
      sourceConnectionId: string,
    ) =>
      database.transaction(
        context.tenantId,
        async (tx) =>
          (
            await tx.query<{ principal_id: string }>(
              'SELECT principal_id FROM stock_protection_policies WHERE tenant_id=$1 AND connection_id=$2 AND source_connection_id=$3',
              [context.tenantId, connectionId, sourceConnectionId],
            )
          ).rows[0]?.principal_id ?? null,
      ),
    async save(
      context: TenantContext,
      settings: StockProtectionConsent,
      principalId: string,
    ) {
      requirePermission(context, 'workspace.approval_policy.manage');
      requireChangesAllowed(context);
      const parsed = parse(settings);

      return database.transaction(context.tenantId, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `exceptions:${context.tenantId}`,
        ]);
        const previous = (
          await tx.query<{ revision: number }>(
            'SELECT revision FROM stock_protection_policies WHERE tenant_id=$1 AND connection_id=$2 AND source_connection_id=$3 FOR UPDATE',
            [context.tenantId, parsed.connectionId, parsed.sourceConnectionId],
          )
        ).rows[0];
        if ((previous?.revision ?? 0) !== parsed.revision)
          throw new IdentityError(
            409,
            'CONFLICT',
            'Stock protection settings changed. Refresh before saving.',
          );
        const document = { ...parsed, revision: parsed.revision + 1 };
        await tx.query(
          'INSERT INTO stock_protection_policies(tenant_id,connection_id,source_connection_id,revision,principal_id,document) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,connection_id,source_connection_id) DO UPDATE SET revision=EXCLUDED.revision,principal_id=EXCLUDED.principal_id,document=EXCLUDED.document',
          [
            context.tenantId,
            parsed.connectionId,
            parsed.sourceConnectionId,
            document.revision,
            principalId,
            document,
          ],
        );
        await tx.query(
          'INSERT INTO stock_protection_policy_revisions(tenant_id,connection_id,source_connection_id,revision,principal_id,document) VALUES($1,$2,$3,$4,$5,$6)',
          [
            context.tenantId,
            parsed.connectionId,
            parsed.sourceConnectionId,
            document.revision,
            principalId,
            document,
          ],
        );
        await tx.query(
          'INSERT INTO autonomy_epochs(tenant_id,revision) VALUES($1,1) ON CONFLICT(tenant_id) DO UPDATE SET revision=autonomy_epochs.revision+1',
          [context.tenantId],
        );

        return document;
      });
    },
  };
}

/** Admits only persisted incident-owned intents and reserves a conservative UTC-day budget once. */
export function createStockProtectionAdmission(database: TenantDatabase) {
  return async (
    context: TenantContext,
    action: import('../domain/action.js').ProposedAction,
  ) =>
    database.transaction(context.tenantId, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `exceptions:${context.tenantId}`,
      ]);
      const rows = await tx.query<{
        settings: StockProtectionConsent;
        principal: string;
        intent: import('../domain/action.js').ProposedAction;
        mode: string;
        stop: boolean;
        count: string;
      }>(
        `
      SELECT p.document AS settings,i.principal_id AS principal,a.document->'action' AS intent,
       i.document->'view'->>'mode' AS mode,(i.document->'view'->>'stopNew')::boolean AS stop,
       (SELECT count(*) FROM jsonb_array_elements(i.document->'view'->'positions') h WHERE h->>'held' IS NOT NULL)::text AS count
      FROM shopify_stock_protection_actions a JOIN shopify_stock_protection_incidents i ON i.tenant_id=a.tenant_id AND i.id=a.incident_id
      JOIN stock_protection_policies p ON p.tenant_id=i.tenant_id AND p.connection_id=i.connection_id AND p.source_connection_id=i.source_connection_id
      WHERE a.tenant_id=$1 AND a.id=$2`,
        [context.tenantId, action.id],
      );
      const row = rows.rows[0];
      if (
        !row ||
        row.principal !== context.actor.id ||
        canonicalJson(row.intent) !== canonicalJson(action) ||
        row.mode !== 'on' ||
        action.capability !== 'inventory.available.protect'
      )
        return false;
      const settings = row.settings;
      if (
        !admitsStockProtection(settings, {
          operation: action.parameters.operation,
          available: action.parameters.available,
          expected: action.parameters.expectedAvailable,
          revision: action.parameters.policyRevision,
          stopNew: row.stop,
          positions: Number(row.count),
        })
      )
        return false;
      const units = Math.abs(
        Number(action.parameters.available) -
          Number(action.parameters.expectedAvailable),
      );
      const previous = await tx.query(
        "SELECT 1 FROM stock_protection_budgets WHERE tenant_id=$1 AND proposal_id=$2 AND utc_day=(now() AT TIME ZONE 'UTC')::date",
        [context.tenantId, action.id],
      );
      if (previous.rowCount) return true;
      const used = (
        await tx.query<{ units: string }>(
          `SELECT COALESCE(sum(units),0)::text AS units FROM stock_protection_budgets WHERE tenant_id=$1 AND connection_id=$2 AND utc_day=(now() AT TIME ZONE 'UTC')::date`,
          [context.tenantId, action.connectionId],
        )
      ).rows[0]!;
      if (Number(used.units) + units > settings.dailyUnits) return false;
      await tx.query(
        `INSERT INTO stock_protection_budgets(tenant_id,proposal_id,connection_id,utc_day,units) VALUES($1,$2,$3,(now() AT TIME ZONE 'UTC')::date,$4)`,
        [context.tenantId, action.id, action.connectionId, units],
      );

      return true;
    });
}
