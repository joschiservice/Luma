import type { SqlTransaction } from '@luma/platform';

import type { SourceRead } from '../../domain/insights.js';
import { connectionLabel, iso, object, text } from '../orders/values.js';

type Row = {
  id: string;
  document: unknown;
  phase: string | null;
  paused: boolean | null;
  blocked: string | null;
  error_code: string | null;
  watermark: Date | null;
  history_from: Date | null;
  last_success_at: Date | null;
};

/**
 * Lists the connections that can supply a record type, or already supplied rows to `table`,
 * with the state of their commerce sync stream. `$1` is the tenant.
 */
export async function readSourceReads(
  tx: SqlTransaction,
  tenantId: string,
  input: {
    recordType: 'orders' | 'fulfillments';
    capability: 'orders.read' | 'fulfillment.read';
    table: 'orders_list' | 'orders_fulfillment_list';
    connectionId: string | undefined;
  },
): Promise<SourceRead[]> {
  const result = await tx.query<Row>(
    `SELECT c.id,c.document,st.phase,st.paused,st.blocked,st.error_code,st.watermark,
      st.history_from,st.last_success_at
     FROM connector_installations c
     LEFT JOIN commerce_sync_streams st ON st.tenant_id=c.tenant_id AND st.connection_id=c.id
      AND st.record_type=$2
     WHERE c.tenant_id=$1 AND ($4::uuid IS NULL OR c.id=$4)
      AND ((c.document->'permissions' ? $3 AND COALESCE(c.document->>'status','') NOT IN ('disconnected','revoked'))
       OR EXISTS (SELECT 1 FROM ${input.table} r WHERE r.tenant_id=$1 AND r.connection_id=c.id))
     ORDER BY c.id`,
    [tenantId, input.recordType, input.capability, input.connectionId ?? null],
  );

  return result.rows
    .map((row) => {
      const document = object(row.document);

      return {
        connectionId: row.id,
        label: connectionLabel(document),
        system: text(object(document.target).kind),
        connectionStatus: text(document.status) ?? 'unknown',
        stream: row.phase
          ? {
              phase: row.phase,
              paused: row.paused === true,
              blocked: row.blocked !== null,
              failing: row.error_code !== null,
              watermark: iso(row.watermark),
              historyFrom: iso(row.history_from),
              lastSuccessAt: iso(row.last_success_at),
            }
          : null,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Reads display labels for connections, keyed by ID. */
export async function readConnectionLabels(
  tx: SqlTransaction,
  tenantId: string,
  ids: string[],
) {
  if (!ids.length) return new Map<string, string>();
  const result = await tx.query<{ id: string; document: unknown }>(
    'SELECT id,document FROM connector_installations WHERE tenant_id=$1 AND id=ANY($2::uuid[])',
    [tenantId, [...new Set(ids)]],
  );

  return new Map(
    result.rows.map((row) => [row.id, connectionLabel(object(row.document))]),
  );
}
