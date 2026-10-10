import { requireTenant } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';

import type { CoverageReader } from '../application/coverage.js';
import { summarizeConnectionCoverage } from '../domain/coverage.js';
import type { InstalledConnection } from '../domain/installation.js';

/**
 * Creates a tenant-scoped coverage reader using observations through `asOf`.
 * Requires a resolved tenant context and propagates database errors.
 */
export function createConnectionCoverage(db: TenantDatabase): CoverageReader {
  return (context, asOf) => {
    requireTenant(context, context.tenantId);

    return db.transaction(context.tenantId, async (tx) => {
      const result = await tx.query<{
        document: InstalledConnection;
        observations: { capability: string; observed_at: string }[];
        failed: boolean;
      }>(
        `SELECT i.document, COALESCE(o.observations, '[]'::jsonb) AS observations, COALESCE(checks.failed, false) AS failed
        FROM connector_installations i
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(latest) AS observations FROM (
            SELECT capability, max(observed_at) AS observed_at
            FROM (
              SELECT document->>'capability' AS capability,
                (document->'observation'->>'observedAt')::timestamptz AS observed_at
              FROM connector_observations
              WHERE tenant_id = $1 AND connection_id = i.id
              UNION ALL
              SELECT capability, observed_at
              FROM connector_read_checks
              WHERE tenant_id = $1 AND connection_id = i.id AND succeeded
            ) evidence
            WHERE observed_at <= $2::timestamptz
            GROUP BY capability
          ) latest
        ) o ON true
        LEFT JOIN LATERAL (
          SELECT bool_or(NOT succeeded) AS failed FROM (
            SELECT DISTINCT ON (capability) succeeded
            FROM connector_read_checks
            WHERE tenant_id=$1 AND connection_id=i.id AND observed_at <= $2::timestamptz
              AND i.document->'permissions' ? capability AND i.document->'granted' ? capability
            ORDER BY capability, observed_at DESC, id DESC
          ) latest
        ) checks ON true
        WHERE i.tenant_id = $1
        ORDER BY i.document->>'label', i.id`,
        [context.tenantId, asOf],
      );

      return result.rows.map(({ document, observations, failed }) =>
        summarizeConnectionCoverage(
          failed && document.status === 'active'
            ? { ...document, status: 'degraded' }
            : document,
          observations.map((observation) => ({
            capability: observation.capability,
            observedAt: observation.observed_at,
          })),
          asOf,
        ),
      );
    });
  };
}
