import type { TenantContext } from '@luma/identity';
import { requirePermission } from '@luma/identity';
import type { SqlTransaction, TenantDatabase } from '@luma/platform';

import { hiddenSections } from '../../application/access.js';
import type {
  ProcurementContextReader,
  ProcurementContextSection,
  ReplenishmentTrace,
  SkuContext,
} from '../../application/procurement.js';
import { readPositions } from '../inventory/positions.js';

type Line = { id: string; sku: string; quantity: number; unit: string };

// Order lines carry a canonical SKU ID, its reconciliation key or a source SKU code. A code
// counts only when exactly one SKU has it.
async function resolveSkus(
  tx: SqlTransaction,
  tenantId: string,
  keys: string[],
) {
  const rows = (
    await tx.query<{
      key: string;
      sku_id: string;
      sku_key: string;
      rank: number;
      title: string | null;
    }>(
      `SELECT k.key,e.id AS sku_id,e.reconciliation_key AS sku_key,
        CASE WHEN e.id::text=k.key THEN 0 WHEN e.reconciliation_key=k.key THEN 1 ELSE 2 END AS rank,
        (SELECT COALESCE(s.document->'data'->>'title',p.code) FROM inventory_product_skus p
          JOIN inventory_projections pr ON pr.tenant_id=p.tenant_id AND pr.entity_id=p.product_id AND pr.connection_id=p.connection_id
          JOIN inventory_snapshots s ON s.tenant_id=pr.tenant_id AND s.id=pr.snapshot_id
          WHERE p.tenant_id=e.tenant_id AND p.sku_id=e.id ORDER BY p.connection_id LIMIT 1) AS title
       FROM unnest($2::text[]) k(key)
       JOIN inventory_entities e ON e.tenant_id=$1 AND e.kind='sku' AND (e.id::text=k.key OR e.reconciliation_key=k.key
        OR EXISTS (SELECT 1 FROM inventory_product_skus p WHERE p.tenant_id=e.tenant_id AND p.sku_id=e.id AND p.code=k.key))
       ORDER BY k.key,rank,e.id`,
      [tenantId, keys],
    )
  ).rows;
  const resolved = new Map<
    string,
    { skuId: string; skuKey: string; title: string | null }
  >();
  for (const key of keys) {
    const matches = rows.filter((r) => r.key === key);
    const best = matches[0];
    if (best && matches.filter((m) => m.rank === best.rank).length === 1)
      resolved.set(key, {
        skuId: best.sku_id,
        skuKey: best.sku_key,
        title: best.title,
      });
  }

  return resolved;
}

async function otherOrders(
  tx: SqlTransaction,
  tenantId: string,
  keys: string[],
  excludeOrder: string | null,
) {
  return (
    await tx.query<{
      sku: string;
      id: string;
      label: string;
      status: string;
      quantity: number;
      unit: string;
      supplier_id: string;
    }>(
      `SELECT line->>'sku' AS sku,p.id,p.document->>'reference' AS label,p.document->>'status' AS status,
        sum((line->>'quantity')::numeric)::float8 AS quantity,line->>'unit' AS unit,p.supplier_id
       FROM procurement_purchase_orders p CROSS JOIN LATERAL jsonb_array_elements(p.document->'lines') line
       WHERE p.tenant_id=$1 AND line->>'sku'=ANY($2::text[]) AND p.document->>'status' IN ('draft','open')
        AND ($3::uuid IS NULL OR p.id<>$3)
       GROUP BY line->>'sku',p.id,p.document,line->>'unit',p.supplier_id,p.created_at ORDER BY p.created_at DESC,p.id LIMIT 201`,
      [tenantId, keys, excludeOrder],
    )
  ).rows;
}

async function skuContexts(
  tx: SqlTransaction,
  tenantId: string,
  skus: string[],
  excludeOrder: string | null,
) {
  const resolved = await resolveSkus(tx, tenantId, skus);
  const aliases = [
    ...new Set(
      skus.flatMap((sku) => {
        const r = resolved.get(sku);

        return r ? [sku, r.skuId, r.skuKey] : [sku];
      }),
    ),
  ];
  const others = await otherOrders(tx, tenantId, aliases, excludeOrder);
  const contexts: (SkuContext & { supplierOrders: typeof others })[] = [];
  let truncated = others.length > 200;
  for (const sku of skus) {
    const r = resolved.get(sku);
    const positions = r
      ? await readPositions(
          tx,
          tenantId,
          { q: '', view: 'all', skuId: r.skuId },
          null,
        )
      : [];
    if (positions.length > 20) truncated = true;
    const names = new Set([sku, ...(r ? [r.skuId, r.skuKey] : [])]);
    const related = others.filter((o) => names.has(o.sku));
    contexts.push({
      sku,
      skuId: r?.skuId ?? null,
      title: r?.title ?? null,
      positions: positions.slice(0, 20),
      otherOrders: related.map(({ id, label, status, quantity, unit }) => ({
        id,
        label,
        status,
        quantity,
        unit,
      })),
      supplierOrders: related,
    });
  }

  return { contexts, truncated };
}

async function issues(
  tx: SqlTransaction,
  tenantId: string,
  skus: { skuId: string | null; positions: { id: string }[] }[],
) {
  const skuIds = skus.flatMap((s) => (s.skuId ? [s.skuId] : []));
  const positionIds = skus.flatMap((s) => s.positions.map((p) => p.id));
  if (!skuIds.length && !positionIds.length) return [];

  return (
    await tx.query<{ id: string; label: string; state: string }>(
      `SELECT DISTINCT e.id,COALESCE(e.document->>'summary',e.document->>'exceptionClass','Stock issue') AS label,e.state
       FROM exceptions e WHERE e.tenant_id=$1 AND (
        (e.subject_kind='position' AND e.subject_id=ANY($3::text[])) OR
        (e.subject_kind='sku' AND (e.subject_id=ANY($2::text[]) OR EXISTS (
         SELECT 1 FROM connector_source_mappings m WHERE m.tenant_id=e.tenant_id AND m.resource='sku'
         AND m.canonical_id::text=ANY($2::text[]) AND m.external_id=e.subject_id
         AND e.document->'subject'->'scope' ? m.connection_id::text))))
       ORDER BY e.state,e.id LIMIT 51`,
      [tenantId, skuIds, positionIds],
    )
  ).rows;
}

async function replenishment(
  tx: SqlTransaction,
  tenantId: string,
  runId: string,
): Promise<ReplenishmentTrace | null> {
  const run = (
    await tx.query<{
      definition_id: string;
      document: {
        createdAt?: string;
        subject?: { kind: string; id: string };
        context?: { inputs?: { activationId?: string } };
      };
    }>(
      'SELECT definition_id,document FROM workflow_trigger_runs WHERE tenant_id=$1 AND id=$2',
      [tenantId, runId],
    )
  ).rows[0];
  if (!run) return null;
  const steps = (
    await tx.query<{
      step_id: string;
      state: string;
      document: {
        values?: Record<string, unknown>;
        observedAt?: string;
        recordedAt?: string;
      };
    }>(
      'SELECT step_id,state,document FROM workflow_process_steps WHERE tenant_id=$1 AND run_id=$2 ORDER BY sequence',
      [tenantId, runId],
    )
  ).rows;
  const step = (id: string) => steps.filter((s) => s.step_id === id).at(-1);
  const activationId = run.document.context?.inputs?.activationId;
  const rule = activationId
    ? (
        await tx.query<{ document: { minimum: number; target: number } }>(
          'SELECT document FROM replenishment_activations WHERE tenant_id=$1 AND id::text=$2',
          [tenantId, activationId],
        )
      ).rows[0]?.document
    : undefined;
  const positionId =
    run.document.subject?.kind === 'inventory_position'
      ? run.document.subject.id
      : null;
  const position = positionId
    ? (
        await readPositions(
          tx,
          tenantId,
          { q: '', view: 'all' },
          null,
          positionId,
        )
      )[0]
    : undefined;
  const inventory = step('inventory');
  const proposal = step('proposal');
  const create = step('create-order');
  const verify = step('verify-order');
  const number = (value: unknown) => (typeof value === 'number' ? value : null);

  return {
    runId,
    definitionId: run.definition_id,
    startedAt: run.document.createdAt ?? inventory?.document.recordedAt ?? '',
    positionId,
    location: position?.location ?? null,
    minimum: rule?.minimum ?? null,
    target: rule?.target ?? null,
    stock: {
      available: number(inventory?.document.values?.available),
      unit:
        typeof inventory?.document.values?.unit === 'string'
          ? inventory.document.values.unit
          : null,
      checkedAt: inventory?.document.observedAt ?? null,
    },
    proposedQuantity: number(proposal?.document.values?.quantity),
    // Purchase-order proposals are at least medium risk, which workspace policy approves.
    approval:
      create?.state === 'completed'
        ? 'approved'
        : create?.state === 'denied'
          ? 'rejected'
          : create?.state === 'waiting'
            ? 'pending'
            : create
              ? 'unknown'
              : 'unknown',
    approvedAt:
      create?.state === 'completed'
        ? (create.document.recordedAt ?? null)
        : null,
    verification:
      verify?.state === 'completed'
        ? 'verified'
        : verify?.state === 'failed'
          ? 'failed'
          : verify?.state === 'inconclusive'
            ? 'inconclusive'
            : 'not_verified',
    verifiedAt: verify?.document.recordedAt ?? null,
  };
}

/** Authorizes a procurement context read and names the sections the reader can't see. */
function authorize(context: TenantContext) {
  requirePermission(context, 'procurement.read');

  return hiddenSections<ProcurementContextSection>(context, [
    ['positions', 'inventory.read'],
    ['issues', 'issues.read'],
  ]);
}

/** Reads purchase-order and supplier context in one repeatable-read snapshot. */
export function createProcurementContext(
  db: TenantDatabase,
): ProcurementContextReader {
  return {
    async order(context, purchaseOrderId) {
      const hidden = authorize(context);

      return db.transaction(
        context.tenantId,
        async (tx) => {
          const order = (
            await tx.query<{
              document: { lines: Line[]; origin: { workflowRunId?: string } };
            }>(
              'SELECT document FROM procurement_purchase_orders WHERE tenant_id=$1 AND id=$2',
              [context.tenantId, purchaseOrderId],
            )
          ).rows[0]?.document;
          if (!order) return null;
          const skus = [...new Set(order.lines.map((l) => l.sku))];
          const { contexts, truncated } = await skuContexts(
            tx,
            context.tenantId,
            skus,
            purchaseOrderId,
          );

          return {
            lines: order.lines.map((line) => {
              const found = contexts.find((c) => c.sku === line.sku)!;

              return {
                lineId: line.id,
                sku: found.sku,
                skuId: found.skuId,
                title: found.title,
                positions: hidden.includes('positions') ? [] : found.positions,
                otherOrders: found.otherOrders,
              };
            }),
            issues: hidden.includes('issues')
              ? []
              : (await issues(tx, context.tenantId, contexts)).slice(0, 50),
            replenishment: order.origin.workflowRunId
              ? await replenishment(
                  tx,
                  context.tenantId,
                  order.origin.workflowRunId,
                )
              : null,
            truncated,
            hidden,
            asOf: new Date().toISOString(),
          };
        },
        { readOnlySnapshot: true },
      );
    },
    async supplier(context, supplierId) {
      const hidden = authorize(context);

      return db.transaction(
        context.tenantId,
        async (tx) => {
          const exists = await tx.query(
            'SELECT 1 FROM procurement_suppliers WHERE tenant_id=$1 AND id=$2',
            [context.tenantId, supplierId],
          );
          if (!exists.rowCount) return null;
          const skus = (
            await tx.query<{ sku: string }>(
              `SELECT line->>'sku' AS sku FROM procurement_purchase_orders p
               CROSS JOIN LATERAL jsonb_array_elements(p.document->'lines') line
               WHERE p.tenant_id=$1 AND p.supplier_id=$2
               GROUP BY line->>'sku' ORDER BY max(p.created_at) DESC,line->>'sku' LIMIT 51`,
              [context.tenantId, supplierId],
            )
          ).rows.map((r) => r.sku);
          const { contexts, truncated } = await skuContexts(
            tx,
            context.tenantId,
            skus.slice(0, 50),
            null,
          );

          return {
            skus: contexts.map(({ supplierOrders, ...sku }) => {
              const onOrder = new Map<string, number>();
              for (const o of supplierOrders.filter(
                (o) => o.supplier_id === supplierId,
              ))
                onOrder.set(o.unit, (onOrder.get(o.unit) ?? 0) + o.quantity);

              return {
                ...sku,
                positions: hidden.includes('positions') ? [] : sku.positions,
                onOrder: [...onOrder].map(([unit, quantity]) => ({
                  unit,
                  quantity,
                })),
              };
            }),
            issues: hidden.includes('issues')
              ? []
              : (await issues(tx, context.tenantId, contexts)).slice(0, 50),
            truncated: truncated || skus.length > 50,
            hidden,
            asOf: new Date().toISOString(),
          };
        },
        { readOnlySnapshot: true },
      );
    },
  };
}
