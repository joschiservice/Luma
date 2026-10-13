import { createHash, randomUUID } from 'node:crypto';

import type { AuditLog } from '@luma/audit';
import { IdentityError } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';
import { canonicalJson } from '@luma/platform';

import type { PurchasingStore } from '../application/purchasing.js';
import type { PurchasingSettings } from '../domain/purchasing.js';
import {
  purchasingPlanSchema,
  purchasingSettingsSchema,
} from './purchasing-validation.js';

const digest = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');

/** Persists purchasing assumptions and immutable plans with tenant RLS, locks and audit. */
export function createPurchasingStore(
  db: TenantDatabase,
  audit: (db: TenantDatabase) => AuditLog,
): PurchasingStore {
  return {
    async settings(context) {
      return db.transaction(context.tenantId, async (tx) => {
        const row = (
          await tx.query<{ document: unknown }>(
            'SELECT document FROM procurement_purchasing_settings WHERE tenant_id=$1',
            [context.tenantId],
          )
        ).rows[0];

        return row
          ? purchasingSettingsSchema.parse(row.document)
          : {
              demandPeriodDays: 30,
              safetyDays: 7,
              locationIds: [],
              revision: 0,
            };
      });
    },
    async saveSettings(context, input) {
      return db.transaction(context.tenantId, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `procurement:${context.tenantId}`,
        ]);
        const row = (
          await tx.query<{ document: PurchasingSettings }>(
            'SELECT document FROM procurement_purchasing_settings WHERE tenant_id=$1',
            [context.tenantId],
          )
        ).rows[0];
        if ((row?.document.revision ?? 0) !== input.revision)
          throw new IdentityError(
            409,
            'CONFLICT',
            'Purchasing settings changed. Refresh and review them.',
          );
        if (input.locationIds.length) {
          const found = await tx.query(
            "SELECT id FROM inventory_entities WHERE tenant_id=$1 AND kind='location' AND id=ANY($2::uuid[])",
            [context.tenantId, input.locationIds],
          );
          if (found.rowCount !== new Set(input.locationIds).size)
            throw new IdentityError(
              409,
              'CONFLICT',
              'Choose locations in this workspace.',
            );
        }
        const updated = { ...input, revision: input.revision + 1 };
        await tx.query(
          'INSERT INTO procurement_purchasing_settings(tenant_id,document) VALUES($1,$2) ON CONFLICT(tenant_id) DO UPDATE SET document=excluded.document',
          [context.tenantId, updated],
        );
        await audit({
          transaction: async (_tenant, operation) => operation(tx),
        }).append({
          id: randomUUID(),
          tenantId: context.tenantId,
          eventKey: `purchasing-settings:${updated.revision}`,
          eventType: 'procurement.purchasing_settings_changed',
          schemaVersion: 1,
          occurredAt: new Date().toISOString(),
          actor: { kind: 'user', id: context.actor.id },
          correlationId: context.requestId,
          proposalId: context.tenantId,
          actionHash: digest(updated),
          evidenceRefs: input.locationIds,
          details: { revision: String(updated.revision) },
        });

        return updated;
      });
    },
    async plans(context) {
      return db.transaction(context.tenantId, async (tx) =>
        (
          await tx.query<{ document: unknown }>(
            'SELECT document FROM procurement_purchasing_plans WHERE tenant_id=$1 ORDER BY created_at DESC,id LIMIT 100',
            [context.tenantId],
          )
        ).rows.map((r) => purchasingPlanSchema.parse(r.document)),
      );
    },
    async plan(context, id) {
      return db.transaction(context.tenantId, async (tx) => {
        const row = (
          await tx.query<{ document: unknown }>(
            'SELECT document FROM procurement_purchasing_plans WHERE tenant_id=$1 AND id=$2',
            [context.tenantId, id],
          )
        ).rows[0];

        return row ? purchasingPlanSchema.parse(row.document) : null;
      });
    },
    async insert(context, plan) {
      return db.transaction(context.tenantId, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `procurement:${context.tenantId}`,
        ]);
        const hash = digest({ actor: plan.requestedBy, request: plan.request });
        const prior = (
          await tx.query<{ document: unknown; digest: string }>(
            'SELECT document,digest FROM procurement_purchasing_plans WHERE tenant_id=$1 AND id=$2',
            [context.tenantId, plan.id],
          )
        ).rows[0];
        if (prior) {
          if (prior.digest !== hash)
            throw new IdentityError(
              409,
              'CONFLICT',
              'This plan ID already belongs to a different request.',
            );

          return purchasingPlanSchema.parse(prior.document);
        }
        const other = await tx.query(
          `SELECT 1 FROM procurement_purchasing_plans p CROSS JOIN LATERAL jsonb_array_elements(p.document->'request'->'lines') l WHERE p.tenant_id=$1 AND p.document->>'state' IN ('approval_required','approved','uncertain') AND (p.document->>'state'='uncertain' OR (p.document->>'expiresAt')::timestamptz>now()) AND l->>'skuId'=ANY($2::text[]) LIMIT 1`,
          [context.tenantId, plan.request.lines.map((l) => l.skuId)],
        );
        if (other.rowCount)
          throw new IdentityError(
            409,
            'CONFLICT',
            'Another purchasing plan already reserves one of these products.',
          );
        await tx.query(
          'INSERT INTO procurement_purchasing_plans(tenant_id,id,supplier_id,document,digest,created_at) VALUES($1,$2,$3,$4,$5,$6)',
          [
            context.tenantId,
            plan.id,
            plan.supplierId,
            plan,
            hash,
            plan.createdAt,
          ],
        );
        await audit({
          transaction: async (_tenant, operation) => operation(tx),
        }).append({
          id: randomUUID(),
          tenantId: context.tenantId,
          eventKey: `purchasing-plan:${plan.id}`,
          eventType: 'procurement.purchasing_plan_proposed',
          schemaVersion: 1,
          occurredAt: plan.createdAt,
          actor: { kind: 'user', id: context.actor.id },
          correlationId: plan.id,
          proposalId: plan.id,
          actionHash: hash,
          evidenceRefs: plan.suggestions.flatMap((s) => s.evidenceRefs),
          details: {
            planId: plan.id,
            supplierId: plan.supplierId,
            reason: plan.request.reason,
          },
        });

        return plan;
      });
    },
    async update(context, plan) {
      await db.transaction(context.tenantId, async (tx) => {
        await tx.query(
          `UPDATE procurement_purchasing_plans SET document=$3 WHERE tenant_id=$1 AND id=$2 AND document->>'state' NOT IN ('verified','rejected','failed','withheld','expired')`,
          [context.tenantId, plan.id, plan],
        );
      });
    },
  };
}
