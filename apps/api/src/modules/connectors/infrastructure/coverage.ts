import type { CoverageReader } from '#modules/connectors/application/coverage';
import { summarizeConnectionCoverage } from '#modules/connectors/domain/coverage';
import type { InstalledConnection } from '#modules/connectors/domain/installation';
import { requireTenant } from '#modules/identity/index';
import type { TenantDatabase } from '#modules/platform/index';

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
      }>(
        `SELECT i.document, COALESCE(o.observations, '[]'::jsonb) AS observations
        FROM connector_installations i
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(latest) AS observations FROM (
            SELECT document->>'capability' AS capability,
              max((document->'observation'->>'observedAt')::timestamptz) AS observed_at
            FROM connector_observations
            WHERE tenant_id = $1 AND connection_id = i.id
              AND (document->'observation'->>'observedAt')::timestamptz <= $2::timestamptz
            GROUP BY document->>'capability'
          ) latest
        ) o ON true
        WHERE i.tenant_id = $1
        ORDER BY i.document->>'label', i.id`,
        [context.tenantId, asOf],
      );

      return result.rows.map(({ document, observations }) =>
        summarizeConnectionCoverage(
          document,
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
