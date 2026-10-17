import { hasPermission, requireTenant } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';

import type { CoverageReader } from '../application/coverage.js';
import { summarizeConnectionCoverage } from '../domain/coverage.js';
import type { InstalledConnection } from '../domain/installation.js';

// The read capability that supplies a sync stream's record type, as in `importedReads`.
const streamCapability = `(CASE s.record_type WHEN 'fulfillments' THEN 'fulfillment.read' WHEN 'inventory_transfers' THEN 'inventory.transfers.read' WHEN 'inventory_shipments' THEN 'inventory.shipments.read' ELSE s.record_type||'.read' END)`;

/**
 * Creates a tenant-scoped coverage reader using observations through `asOf`.
 * Only permitted, granted capabilities are read, one indexed latest-row lookup per source,
 * because coverage ignores evidence for any other capability.
 * Requires a resolved tenant context and propagates database errors.
 */
export function createConnectionCoverage(db: TenantDatabase): CoverageReader {
  return (context, asOf) => {
    requireTenant(context, context.tenantId);

    return db.transaction(context.tenantId, async (tx) => {
      const result = await tx.query<{
        document: InstalledConnection;
        observations: { capability: string; observed_at: string | null }[];
        failed: boolean;
        streams: NonNullable<
          import('../domain/coverage.js').ConnectionCoverage['streams']
        >;
      }>(
        `SELECT i.document, COALESCE(coverage.observations, '[]'::jsonb) AS observations, (COALESCE(coverage.failed, false) OR EXISTS (SELECT 1 FROM commerce_sync_streams s WHERE s.tenant_id=i.tenant_id AND s.connection_id=i.id AND s.error_code IS NOT NULL) OR EXISTS(SELECT 1 FROM exceptions e WHERE e.tenant_id=i.tenant_id AND e.state<>'resolved' AND e.document->>'exceptionClass'='sync_failure' AND e.subject_id=i.id::text)) AS failed,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('recordType',s.record_type,'lastSuccessfulAt',to_char(s.last_complete_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'lastError',s.error_code,'issueIds',${hasPermission(context, 'issues.read') ? `(SELECT COALESCE(jsonb_agg(e.id),'[]'::jsonb) FROM exceptions e WHERE e.tenant_id=s.tenant_id AND e.state<>'resolved' AND e.subject_id=i.id::text AND e.document->'subject'->'scope' ? ${streamCapability})` : "'[]'::jsonb"})) FROM commerce_sync_streams s WHERE s.tenant_id=i.tenant_id AND s.connection_id=i.id),'[]'::jsonb) AS streams
        FROM connector_installations i
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(jsonb_build_object('capability',caps.capability,'observed_at',latest.observed_at)) AS observations,
            bool_or(NOT last_check.succeeded) AS failed
          FROM (
            SELECT DISTINCT capability FROM jsonb_array_elements_text(i.document->'granted') capability
            WHERE i.document->'permissions' ? capability
          ) caps
          CROSS JOIN LATERAL (
            SELECT GREATEST(
              (SELECT o.observed_at FROM connector_observations o
                WHERE o.tenant_id=$1 AND o.connection_id=i.id AND o.capability=caps.capability AND o.observed_at <= $2::timestamptz
                ORDER BY o.observed_at DESC LIMIT 1),
              (SELECT r.observed_at FROM connector_read_checks r
                WHERE r.tenant_id=$1 AND r.connection_id=i.id AND r.capability=caps.capability AND r.succeeded AND r.observed_at <= $2::timestamptz
                ORDER BY r.observed_at DESC LIMIT 1),
              (SELECT max(s.last_success_at) FROM commerce_sync_streams s
                WHERE s.tenant_id=$1 AND s.connection_id=i.id AND s.last_success_at <= $2::timestamptz
                  AND ${streamCapability}=caps.capability)
            ) AS observed_at
          ) latest
          LEFT JOIN LATERAL (
            SELECT r.succeeded FROM connector_read_checks r
            WHERE r.tenant_id=$1 AND r.connection_id=i.id AND r.capability=caps.capability AND r.observed_at <= $2::timestamptz
            ORDER BY r.observed_at DESC, r.id DESC LIMIT 1
          ) last_check ON true
        ) coverage ON true
        WHERE i.tenant_id = $1
        ORDER BY i.document->>'label', i.id`,
        [context.tenantId, asOf],
      );

      return result.rows.map(({ document, observations, failed, streams }) => ({
        ...summarizeConnectionCoverage(
          failed && document.status === 'active'
            ? { ...document, status: 'degraded' }
            : document,
          // Unobserved capabilities are dropped here rather than in SQL, which would repeat
          // the latest-row lookups for a second reference.
          observations.flatMap(({ capability, observed_at }) =>
            observed_at ? [{ capability, observedAt: observed_at }] : [],
          ),
          asOf,
        ),
        streams: streams ?? [],
      }));
    });
  };
}
