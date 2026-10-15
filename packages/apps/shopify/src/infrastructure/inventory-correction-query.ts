import { createHash } from 'node:crypto';

import type { AuthorityReader } from '@luma/connections';
import type { TenantContext } from '@luma/identity';
import { IdentityError } from '@luma/identity';
import { canonicalJson, type TenantDatabase } from '@luma/platform';
import { z } from 'zod';

import {
  type CorrectionCandidate,
  correctionTarget,
} from '../domain/inventory-correction.js';
import { createNativeAllocationQuery } from './native-allocation-query.js';
import { createReceiptStockQuery } from './receipt-stock-query.js';

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
export function createCorrectionQuery(
  database: TenantDatabase,
  sourceAuthority?: AuthorityReader,
  receiptReleased: (tenantId: string) => Promise<boolean> = async () => false,
) {
  const receipts = createReceiptStockQuery(
    database,
    sourceAuthority,
    receiptReleased,
  );
  const nativeAllocation = createNativeAllocationQuery(database);

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
    configurationKey: (context: TenantContext) =>
      database.transaction(
        context.tenantId,
        async (tx) =>
          (
            await tx.query<{ key: string }>(
              `SELECT COALESCE((SELECT detection FROM workspace_settings WHERE tenant_id=$1),'{"inventoryTolerance":"0","propagationSeconds":1800,"oversellPropagationSeconds":120,"stuckSeconds":7200}'::jsonb)::text AS key`,
              [context.tenantId],
            )
          ).rows[0]!.key,
      ),
    receipts,
    /** Pins the stock position's product label to the catalog read available at preview time. */
    product: (
      context: TenantContext,
      target: z.infer<typeof correctionTarget>,
    ) =>
      database.transaction(context.tenantId, async (tx) => {
        const result = await tx.query<{
          skuId: string;
          sku: string | null;
          title: string | null;
          observationId: string | null;
          observedAt: string | null;
        }>(
          `SELECT s.sku_id AS "skuId",
         CASE WHEN count(DISTINCT k.code)=1 THEN min(k.code) END AS sku,
         CASE WHEN count(DISTINCT p.document->'data'->>'title')=1 THEN min(p.document->'data'->>'title') END AS title,
         CASE WHEN count(DISTINCT p.observation_id)=1 THEN min(p.observation_id::text) END AS "observationId",
         min(p.document->>'observedAt') AS "observedAt"
         FROM inventory_projections i JOIN inventory_snapshots s ON s.tenant_id=i.tenant_id AND s.id=i.snapshot_id
         LEFT JOIN inventory_product_skus k ON k.tenant_id=s.tenant_id AND k.sku_id=s.sku_id AND k.connection_id=i.connection_id
         LEFT JOIN inventory_projections ip ON ip.tenant_id=k.tenant_id AND ip.entity_id=k.product_id AND ip.connection_id=k.connection_id
         LEFT JOIN inventory_snapshots p ON p.tenant_id=ip.tenant_id AND p.id=ip.snapshot_id
         WHERE i.tenant_id=$1 AND i.entity_id=$2 AND i.connection_id=$3 AND s.kind='position' GROUP BY s.sku_id`,
          [context.tenantId, target.positionId, target.connectionId],
        );

        return result.rows[0] ?? null;
      }),
    /** Finds the stock position that projects a canonical SKU at a canonical location. */
    position: (context: TenantContext, skuId: string, locationId: string) =>
      database.transaction(context.tenantId, async (tx) => {
        const result = await tx.query<{ id: string }>(
          `SELECT p.entity_id AS id FROM inventory_projections p
           JOIN inventory_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id
           WHERE p.tenant_id=$1 AND s.kind='position' AND s.document->'data'->>'skuId'=$2
            AND s.document->'data'->>'locationId'=$3
           GROUP BY p.entity_id ORDER BY p.entity_id LIMIT 2`,
          [context.tenantId, skuId, locationId],
        );

        // Two positions for one SKU and location would make the subject ambiguous.
        return result.rows.length === 1 ? result.rows[0]!.id : null;
      }),
    async candidates(
      context: TenantContext,
      positionId: string,
    ): Promise<CorrectionCandidate[]> {
      const values = await rows(context, positionId);
      const owned = await database.transaction(
        context.tenantId,
        async (tx) =>
          (
            await tx.query<{
              connection_id: string;
              sku_id: string;
              location_id: string;
              available: string;
            }>(
              `
       SELECT o.connection_id,a.sku_id,a.location_id,trim_scale(a.balance)::text available FROM inventory_stock_ownership_scopes o
       JOIN inventory_ledger_accounts a ON a.tenant_id=o.tenant_id AND a.location_id=o.location_id AND a.state='available'
       WHERE o.tenant_id=$1 AND o.mode='own' AND a.sku_id=ANY($2::uuid[]) AND a.location_id=ANY($3::uuid[]) AND a.unit='each'`,
              [
                context.tenantId,
                values.map((value) => value.skuId),
                values.map((value) => value.locationId),
              ],
            )
          ).rows,
      );
      const native = values.flatMap((value) => {
        const scope = owned.find(
          (row) =>
            row.connection_id === value.connectionId &&
            row.sku_id === value.skuId &&
            row.location_id === value.locationId,
        );

        return scope
          ? [
              {
                connectionId: value.connectionId,
                label: 'Luma native stock',
                provider: 'native_stock',
                available: scope.available,
                observedAt: value.observedAt,
              },
            ]
          : [];
      });
      const providers = values
        .filter(
          (row) =>
            row.active &&
            row.installed &&
            row.readable &&
            !row.deleted &&
            ['shopify', 'jtl'].includes(row.provider),
        )
        .filter((row) => !native.length || row.provider === 'shopify')
        .map(({ connectionId, label, provider, available, observedAt }) => ({
          connectionId,
          label,
          provider,
          available,
          observedAt,
        }));

      return [...providers, ...native];
    },
    async authority(
      context: TenantContext,
      target: z.infer<typeof correctionTarget>,
      receiptProof = false,
    ) {
      const authority = await sourceAuthority?.read(context);
      if (target.receipt) {
        if (
          target.nativeAllocation ||
          target.sourceConnectionId !== target.connectionId
        )
          throw new IdentityError(
            409,
            'CONFLICT',
            'A receipt must use one stock authority.',
          );
        const source = (await rows(context, target.positionId)).find(
          (row) => row.connectionId === target.connectionId,
        );
        if (
          !source ||
          source.provider !== 'shopify' ||
          !source.active ||
          !source.installed ||
          !source.readable ||
          source.deleted ||
          source.unit !== 'each'
        )
          throw new IdentityError(
            409,
            'CONFLICT',
            'Receipt stock needs an active, readable Shopify position.',
          );
        const inventoryItemId = exact(source, 'sku'),
          locationId = exact(source, 'location');
        if (
          !/^gid:\/\/shopify\/InventoryItem\/[0-9]+$/.test(inventoryItemId) ||
          !/^gid:\/\/shopify\/Location\/[0-9]+$/.test(locationId)
        )
          throw new IdentityError(
            409,
            'CONFLICT',
            'Confirm exact Shopify item and location mappings.',
          );

        return {
          inventoryItemId,
          locationId,
          source: await receipts.source(
            context,
            target.receipt,
            target.connectionId,
            target.positionId,
            receiptProof,
          ),
        };
      }
      if (target.nativeAllocation) {
        if (!authority)
          throw new IdentityError(
            409,
            'CONFLICT',
            'Source authority is unavailable.',
          );
        const source = (await rows(context, target.positionId)).find(
          (row) => row.connectionId === target.connectionId,
        );
        if (!source)
          throw new IdentityError(
            404,
            'NOT_FOUND',
            'The selected Shopify stock position was not found.',
          );
        const inventoryItemId = exact(source, 'sku'),
          locationId = exact(source, 'location');
        if (
          !/^gid:\/\/shopify\/InventoryItem\/[0-9]+$/.test(inventoryItemId) ||
          !/^gid:\/\/shopify\/Location\/[0-9]+$/.test(locationId)
        )
          throw new IdentityError(
            409,
            'CONFLICT',
            'Confirm exact Shopify item and location mappings before publication.',
          );

        return {
          inventoryItemId,
          locationId,
          source: await nativeAllocation(context, target, source, authority),
        };
      }
      const stockAuthority = authority?.groups.find(
        (group) => group.group === 'inventory_stock',
      );
      const sellingAuthority = authority?.groups.find(
        (group) => group.group === 'inventory_selling',
      );
      if (
        stockAuthority?.connectionId !== target.sourceConnectionId ||
        sellingAuthority?.connectionId !== target.connectionId
      )
        throw new IdentityError(
          409,
          'CONFLICT',
          'Source authority changed or is inconclusive. Review the workspace source authority before correcting stock.',
        );
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
      const owned = await database.transaction(
        context.tenantId,
        async (tx) =>
          (
            await tx.query(
              `SELECT 1 FROM inventory_stock_ownership_scopes WHERE tenant_id=$1 AND location_id=$2 AND mode='own'`,
              [context.tenantId, shopify.locationId],
            )
          ).rowCount,
      );
      if (owned)
        throw new IdentityError(
          409,
          'CONFLICT',
          'This location uses native stock. Publish a reviewed native allocation instead of applying an ERP correction.',
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

      // The revision covers the authoritative value and mappings, not which read reported it:
      // a newer read of the same quantity keeps a reviewed correction valid. Freshness is
      // checked separately against `observedAt`.
      const sourceFacts = {
        connectionId: erp.connectionId,
        provider: erp.provider,
        active: erp.active,
        installed: erp.installed,
        readable: erp.readable,
        deleted: erp.deleted,
        skuId: erp.skuId,
        locationId: erp.locationId,
        unit: erp.unit,
        available: erp.available,
        mappings: erp.mappings,
      };

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
            .update(
              canonicalJson({
                source: sourceFacts,
                authorityRevision: authority!.revision,
                targetMappings: shopify.mappings,
              }),
            )
            .digest('hex'),
        },
      };
    },
  };
}
