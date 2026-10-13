import type { TenantContext } from '@luma/identity';
import { requirePermission, requireTenant } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';

import { incompleteReads, lineReferences } from './change-plan.js';
import { readSourceFacts } from './detail-facts.js';
import { resolveOrderEntity } from './identity-references.js';
import type { OrderReadQueries } from './list-query.js';

const scale = 1_000_000n;

/** A source's stored read of an order's line quantities, by the other source's line IDs. */
interface SourceOrderLines {
  /** The canonical order both sources report. */
  orderId: string;
  connectionId: string;
  snapshotId: string;
  observationId: string;
  observedAt: string;
  complete: boolean;
  lines: { externalId: string; quantity: string | null }[];
}

/** Exact current units: reported, or ordered minus cancelled; null when neither is known. */
export function currentUnits(line: {
  quantity: string;
  currentQuantity: string | null;
  cancelledQuantity: string | null;
}) {
  if (line.currentQuantity !== null) return line.currentQuantity;
  if (line.cancelledQuantity === null) return null;
  const units = (value: string) => {
    const [whole = '0', fraction = ''] = value.split('.');

    return BigInt(whole) * scale + BigInt(fraction.padEnd(6, '0'));
  };
  const value = units(line.quantity) - units(line.cancelledQuantity);
  const fraction = (value % scale)
    .toString()
    .padStart(6, '0')
    .replace(/0+$/, '');

  return `${value / scale}${fraction ? `.${fraction}` : ''}`;
}

/**
 * Reads another connection's current line quantities for a source order from Luma's stored
 * reads, matching lines as source comparisons do: by shared canonical line ID or a mapped SKU
 * that occurs once per source. Lines without such a match report a null quantity. Requires
 * `orders.read`; returns null unless the order is linked, once, to both connections.
 */
export function createSourceOrderLines(
  db: TenantDatabase,
  queries: Pick<OrderReadQueries, 'state'>,
  now = () => new Date(),
) {
  return async (
    context: TenantContext,
    input: {
      connectionId: string;
      orderId: string;
      sourceConnectionId: string;
    },
  ): Promise<SourceOrderLines | null> => {
    requireTenant(context, context.tenantId);
    requirePermission(context, 'orders.read');
    const asOf = now().toISOString();

    return db.transaction(
      context.tenantId,
      async (tx) => {
        await tx.query("SET LOCAL statement_timeout = '4000ms'");
        const tenantId = context.tenantId;
        const mapped = (
          await tx.query<{ id: string }>(
            `SELECT DISTINCT canonical_id::text AS id FROM connector_source_mappings
             WHERE tenant_id=$1 AND connection_id=$2 AND resource='order' AND external_id=$3`,
            [tenantId, input.connectionId, input.orderId],
          )
        ).rows;
        const [only] = mapped;
        if (!only || mapped.length !== 1) return null;
        const orderId = await resolveOrderEntity(tx, tenantId, only.id);
        const facts = await readSourceFacts(
          tx,
          queries,
          tenantId,
          orderId,
          asOf,
        );
        const shown = facts?.sources.find(
          (item) => item.connectionId === input.connectionId && !item.deleted,
        );
        const source = facts?.sources.find(
          (item) =>
            item.connectionId === input.sourceConnectionId && !item.deleted,
        );
        if (!shown || !source) return null;
        const snapshot = (
          await tx.query<{ id: string; observationId: string }>(
            `SELECT s.id::text,s.document->>'observationId' AS "observationId"
             FROM orders_projections p JOIN orders_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id
             WHERE p.tenant_id=$1 AND p.entity_id=$2 AND p.connection_id=$3`,
            [tenantId, orderId, input.sourceConnectionId],
          )
        ).rows[0];
        if (!snapshot) return null;
        const incomplete = await incompleteReads(
          tx,
          tenantId,
          asOf,
          [input.sourceConnectionId],
          source.observedAt,
        );
        const refs =
          (
            await lineReferences(
              tx,
              tenantId,
              shown.lines.map((line) => line.id),
            )
          ).get(input.connectionId) ?? {};
        // Identity is ambiguous when either source has a line no key matches.
        const ambiguous = [shown, source].some((item) =>
          item.lines.some((line) => !line.comparisonKey),
        );

        return {
          orderId,
          connectionId: input.sourceConnectionId,
          snapshotId: snapshot.id,
          observationId: snapshot.observationId,
          observedAt: source.observedAt,
          complete: !incomplete.has(input.sourceConnectionId),
          lines: shown.lines.flatMap((line) => {
            const externalId = refs[line.id];
            if (!externalId) return [];
            const [match, ...others] = source.lines.filter(
              (candidate) =>
                !ambiguous && candidate.comparisonKey === line.comparisonKey,
            );

            return [
              {
                externalId,
                quantity: match && !others.length ? currentUnits(match) : null,
              },
            ];
          }),
        };
      },
      { readOnlySnapshot: true },
    );
  };
}
