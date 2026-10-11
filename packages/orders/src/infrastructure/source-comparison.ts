import { orderComparisonPolicy } from '../domain/source-comparison.js';

function incompleteReadSql(alias: string) {
  return `EXISTS (SELECT 1 FROM orders_list source
    CROSS JOIN (VALUES ('orders.read'),('fulfillment.read')) capability(name)
    JOIN LATERAL (SELECT observed_at,succeeded,document FROM connector_read_checks
      WHERE tenant_id=$1 AND connection_id=source.connection_id AND capability=capability.name AND observed_at<=$2
      ORDER BY observed_at DESC,id DESC LIMIT 1) latest ON true
    WHERE source.tenant_id=$1 AND source.entity_id=${alias}.entity_id AND NOT source.deleted
      AND latest.observed_at>=${alias}.comparison_read_at
      AND (NOT latest.succeeded OR latest.document->'value'->>'completeness' IS DISTINCT FROM 'complete'
        OR latest.document->'value'->>'nextCursor' IS NOT NULL))`;
}

/** Read-time state over maintained comparisons. Future and stale evidence never confirms a difference. */
export function comparisonStateSql(alias: string) {
  return `CASE WHEN ${alias}.comparison_raw='inconclusive' THEN 'inconclusive'
    WHEN ${alias}.comparison_read_at IS NULL THEN 'matching'
    WHEN ${alias}.comparison_latest_read_at>$2 OR ${alias}.comparison_read_at<$2::timestamptz-interval '${orderComparisonPolicy.freshnessSeconds} seconds' THEN 'inconclusive'
    WHEN ${incompleteReadSql(alias)} THEN 'inconclusive'
    WHEN ${alias}.comparison_raw='matching' THEN 'matching'
    WHEN ${alias}.comparison_read_at>=${alias}.comparison_confirm_after THEN 'confirmed' ELSE 'pending' END`;
}

/** Reads bounded owner-maintained comparison evidence for the requested canonical orders. */
export function sourceComparison(_sources: string, entities: string) {
  const hidden = `EXISTS(SELECT 1 FROM orders_list h WHERE h.tenant_id=$1 AND h.entity_id=o.entity_id AND h.connection_id=ANY(COALESCE(NULLIF(current_setting('app.hidden_order_sources',true),''),'{}')::uuid[]))`;

  return `source_differences AS MATERIALIZED (
    SELECT DISTINCT ON(o.entity_id) o.entity_id,CASE WHEN ${hidden} THEN 'inconclusive' ELSE ${comparisonStateSql('o')} END AS state,CASE WHEN ${hidden} THEN '[]'::jsonb ELSE o.comparison_differences END AS differences,
      jsonb_build_object('raw',o.comparison_raw,'readAt',o.comparison_read_at,'latestReadAt',o.comparison_latest_read_at,'confirmAfter',o.comparison_confirm_after) AS timing,${incompleteReadSql('o')} AS incomplete
    FROM orders_list o WHERE o.tenant_id=$1 AND o.entity_id IN (SELECT entity_id FROM ${entities})
    ORDER BY o.entity_id,o.selected DESC,o.connection_id
  )`;
}

/** SQL condition that only admits freshly confirmed differences to the differs flag and filter. */
export const anyDifference = "d.state='confirmed'";
