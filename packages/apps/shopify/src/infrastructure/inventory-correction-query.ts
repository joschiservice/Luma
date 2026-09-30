import { createHash } from 'node:crypto';

import type { TenantContext } from '@luma/identity';
import { IdentityError } from '@luma/identity';
import { canonicalJson, type TenantDatabase } from '@luma/platform';
import { z } from 'zod';

import {
  type CorrectionCandidate,
  correctionTarget,
} from '../domain/inventory-correction.js';

const rowSchema = z.object({
  connectionId: z.string().uuid(),
  label: z.string(),
  provider: z.string(),
  active: z.boolean(),
  installed: z.boolean(),
  readable: z.boolean(),
  observationId: z.string().uuid(),
  observedAt: z.string(),
  deleted: z.boolean(),
  skuId: z.string().uuid(),
  locationId: z.string().uuid(),
  unit: z.string(),
  available: z.string().nullable(),
  mappings: z.array(
    z.object({
      resource: z.string(),
      externalId: z.string(),
      scopeKey: z.string(),
    }),
  ),
});

type Row = z.infer<typeof rowSchema>;

/** Reads source authority and exact mappings without writing inventory-owned projections. */
export function createCorrectionQuery(database: TenantDatabase) {
  async function rows(
    context: TenantContext,
    positionId: string,
  ): Promise<Row[]> {
    return database.transaction(context.tenantId, async (tx) => {
      const result = await tx.query(
        `SELECT p.connection_id AS "connectionId",c.document->>'label' AS label,
         c.document->>'provider' AS provider,c.document->>'status'='active' AS active,
         EXISTS(SELECT 1 FROM workspace_apps a WHERE a.tenant_id=p.tenant_id AND a.app_id=c.document->>'appId'
          AND a.status='installed' AND a.version=(c.document->>'appInstallationVersion')::int) AS installed,
         c.document->'permissions' ? 'inventory.read' AND c.document->'granted' ? 'inventory.read' AS readable,
         s.document->>'observationId' AS "observationId",s.document->>'observedAt' AS "observedAt",
         (s.document->>'deleted')::boolean AS deleted,s.document->'data'->>'skuId' AS "skuId",
         s.document->'data'->>'locationId' AS "locationId",s.document->'data'->>'unit' AS unit,
         s.document->'data'->>'available' AS available,
         COALESCE((SELECT jsonb_agg(jsonb_build_object('resource',m.resource,'externalId',m.external_id,'scopeKey',m.scope_key)
          ORDER BY m.resource,m.external_id,m.scope_key) FROM connector_source_mappings m WHERE m.tenant_id=p.tenant_id
          AND m.connection_id=p.connection_id AND ((m.resource='sku' AND m.canonical_id=(s.document->'data'->>'skuId')::uuid)
           OR (m.resource='location' AND m.canonical_id=(s.document->'data'->>'locationId')::uuid))),'[]'::jsonb) AS mappings
         FROM inventory_projections p JOIN inventory_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id
         JOIN connector_installations c ON c.tenant_id=p.tenant_id AND c.id=p.connection_id
         WHERE p.tenant_id=$1 AND p.entity_id=$2 AND s.kind='position'`,
        [context.tenantId, positionId],
      );

      return z.array(rowSchema).parse(result.rows);
    });
  }

  function exact(row: Row, resource: string) {
    const mappings = row.mappings.filter((m) => m.resource === resource);
    if (mappings.length !== 1 || mappings[0]!.scopeKey !== '')
      throw new IdentityError(
        409,
        'CONFLICT',
        'SKU or location mappings are ambiguous. Confirm one exact source mapping before correcting stock.',
      );

    return mappings[0]!.externalId;
  }

  return {
    async candidates(
      context: TenantContext,
      positionId: string,
    ): Promise<CorrectionCandidate[]> {
      return (await rows(context, positionId))
        .filter(
          (r) =>
            r.active &&
            r.installed &&
            r.readable &&
            !r.deleted &&
            ['shopify', 'jtl'].includes(r.provider),
        )
        .map(({ connectionId, label, provider, available, observedAt }) => ({
          connectionId,
          label,
          provider,
          available,
          observedAt,
        }));
    },
    async authority(
      context: TenantContext,
      target: z.infer<typeof correctionTarget>,
    ) {
      const sources = await rows(context, target.positionId);
      const shopify = sources.find(
        (r) => r.connectionId === target.connectionId,
      );
      const erp = sources.find(
        (r) => r.connectionId === target.sourceConnectionId,
      );
      if (!shopify || !erp)
        throw new IdentityError(
          404,
          'NOT_FOUND',
          'Stock sources not found for this position.',
        );
      if (
        shopify.provider !== 'shopify' ||
        erp.provider !== 'jtl' ||
        shopify.connectionId === erp.connectionId
      )
        throw new IdentityError(
          409,
          'CONFLICT',
          'Only a confirmed ERP source can authorize a Shopify correction.',
        );
      if (
        [shopify, erp].some(
          (r) =>
            !r.active ||
            !r.installed ||
            !r.readable ||
            r.deleted ||
            r.unit !== 'each',
        ) ||
        shopify.skuId !== erp.skuId ||
        shopify.locationId !== erp.locationId
      )
        throw new IdentityError(
          409,
          'CONFLICT',
          'Sources must be active, installed and mapped to the same SKU, location and whole-unit stock.',
        );
      exact(erp, 'sku');
      exact(erp, 'location');
      const inventoryItemId = exact(shopify, 'sku'),
        locationId = exact(shopify, 'location');
      if (
        !/^gid:\/\/shopify\/InventoryItem\/[0-9]+$/.test(inventoryItemId) ||
        !/^gid:\/\/shopify\/Location\/[0-9]+$/.test(locationId)
      )
        throw new IdentityError(
          409,
          'CONFLICT',
          'Shopify requires an exact inventory item and location mapping.',
        );
      const quantity = erp.available === null ? NaN : Number(erp.available);
      if (
        !Number.isSafeInteger(quantity) ||
        quantity < 0 ||
        quantity > 2147483647
      )
        throw new IdentityError(
          409,
          'CONFLICT',
          'The ERP available quantity must be a known, nonnegative whole number.',
        );

      return {
        inventoryItemId,
        locationId,
        source: {
          connectionId: erp.connectionId,
          label: erp.label,
          observationId: erp.observationId,
          observedAt: erp.observedAt,
          available: quantity,
          revision: createHash('sha256')
            .update(canonicalJson({ erp, targetMappings: shopify.mappings }))
            .digest('hex'),
        },
      };
    },
  };
}
