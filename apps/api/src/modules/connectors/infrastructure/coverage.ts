import { requireTenant } from '#modules/identity/index';
import type { TenantDatabase } from '#modules/platform/index';
import type { CoverageReader } from '#modules/connectors/application/coverage';
import type { InstalledConnection } from '#modules/connectors/domain/installation';
export function createConnectionCoverage(db: TenantDatabase): CoverageReader {
  return (context, asOf) => {
    requireTenant(context, context.tenantId);
    return db.transaction(context.tenantId, async (tx) => {
      const result = await tx.query<{
        document: InstalledConnection;
        observations: { capability: string; observed_at: string }[];
      }>(
        `SELECT i.document, COALESCE(o.observations,'[]'::jsonb) AS observations
        FROM connector_installations i
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(latest) AS observations FROM (
            SELECT document->>'capability' AS capability,
              max((document->'observation'->>'observedAt')::timestamptz) AS observed_at
            FROM connector_observations WHERE tenant_id=$1 AND connection_id=i.id
              AND (document->'observation'->>'observedAt')::timestamptz <= $2::timestamptz
            GROUP BY document->>'capability'
          ) latest
        ) o ON true WHERE i.tenant_id=$1 ORDER BY i.document->>'label',i.id`,
        [context.tenantId, asOf],
      );
      return result.rows.map(({ document: c, observations }) => {
        const reads = c.granted.filter(
          (capability) =>
            capability.endsWith('.read') && c.permissions.includes(capability),
        );
        const times = observations
          .filter((o) => reads.includes(o.capability as (typeof reads)[number]))
          .map((o) => Date.parse(o.observed_at));
        const missing =
          !reads.length ||
          reads.some(
            (capability) =>
              !observations.some((o) => o.capability === capability),
          );
        return {
          id: c.id,
          label: c.label,
          status: c.status,
          lastObservedAt: times.length
            ? new Date(Math.max(...times)).toISOString()
            : null,
          freshness: missing
            ? ('unobserved' as const)
            : Math.min(...times) < Date.parse(asOf) - 24 * 60 * 60 * 1000
              ? ('stale' as const)
              : ('fresh' as const),
        };
      });
    });
  };
}
