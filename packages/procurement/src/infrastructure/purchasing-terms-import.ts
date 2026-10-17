import { createHash } from 'node:crypto';

import type { Observation, ProductSnapshot } from '@luma/connections';
import type { TenantContext } from '@luma/identity';
import { hasPermission } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';

import type { SupplierTermsService } from '../application/supplier-terms.js';

/** Imports purchasing metadata only after SKU projection, through explicit supplier and SKU links. */
export function createPurchasingTermsImporter(
  db: TenantDatabase,
  terms: SupplierTermsService,
) {
  return async (
    context: TenantContext,
    observations: Observation<ProductSnapshot>[],
    completeRead: boolean,
  ) => {
    if (
      !hasPermission(context, 'procurement.manage') ||
      !hasPermission(context, 'procurement.read') ||
      !(await terms.enabled(context))
    )
      return;
    for (const observation of observations) {
      if (
        observation.kind !== 'snapshot' ||
        observation.source.tenantId !== context.tenantId
      )
        continue;
      for (const sku of observation.data.skus) {
        for (const report of sku.purchasingTerms ?? []) {
          const identities = await db.transaction(
            context.tenantId,
            async (tx) =>
              (
                await tx.query<{ supplier_id: string; sku_id: string }>(
                  `SELECT s.id AS supplier_id,m.canonical_id AS sku_id FROM procurement_suppliers s
             JOIN connector_source_mappings m ON m.tenant_id=s.tenant_id AND m.connection_id=$2 AND m.resource='sku'
              AND m.scope_key=$3 AND m.external_id=$4
             WHERE s.tenant_id=$1 AND s.document->'link'->>'connectionId'=$2::text
              AND s.document->'link'->>'scopeKey'=$5 AND s.document->'link'->>'externalId'=$6`,
                  [
                    context.tenantId,
                    observation.source.connectionId,
                    sku.id.scopeKey,
                    sku.id.externalId,
                    report.supplier.scopeKey,
                    report.supplier.externalId,
                  ],
                )
              ).rows,
          );
          // Ambiguous or missing mappings never become an inferred identity.
          if (identities.length !== 1) continue;
          const identity = identities[0]!;
          const { sourceRecordId, complete } = report;
          const values = {
            supplierArticleNumber: report.supplierArticleNumber,
            unitPrice: report.unitPrice,
            packSize: report.packSize,
            lineMinimumQuantity: report.lineMinimumQuantity,
            orderMinimumValue: report.orderMinimumValue,
            leadTimeDays: report.leadTimeDays,
            preferred: report.preferred,
          };
          const hash = createHash('sha256')
            .update(
              JSON.stringify([
                observation.id,
                identity.supplier_id,
                identity.sku_id,
                sourceRecordId,
              ]),
            )
            .digest('hex');
          const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
          await terms.observe(
            context,
            {
              id,
              supplierId: identity.supplier_id,
              skuId: identity.sku_id,
              expectedRevision: 0,
              reason: 'Purchasing-system product read',
              values,
            },
            {
              source: 'provider',
              connectionId: observation.source.connectionId,
              sourceRecordId,
              complete: complete && completeRead,
              observedAt: observation.observedAt,
              sourceUpdatedAt: observation.sourceUpdatedAt,
            },
          );
        }
      }
    }
  };
}
