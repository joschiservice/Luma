import type { TenantContext } from '@luma/identity';
import { requirePermission } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';

import type {
  CapabilityResult,
  ReadCapability,
} from '../domain/capabilities.js';

/** Stores validated runtime read outcomes, including empty pages, for connection coverage. Requires `sync.manage`. */
export function createReadChecks(db: TenantDatabase) {
  return async (
    context: TenantContext,
    connectionId: string,
    capability: ReadCapability,
    result: CapabilityResult<ReadCapability>,
  ) => {
    requirePermission(context, 'sync.manage');
    if (
      result.ok &&
      result.value.items.some(
        ({ source }) =>
          source.tenantId !== context.tenantId ||
          source.connectionId !== connectionId,
      )
    )
      throw new Error('Observation provenance mismatch');
    await db.transaction(context.tenantId, async (tx) => {
      const saved = await tx.query(
        `INSERT INTO connector_read_checks(tenant_id,connection_id,capability,observed_at,succeeded,document)
        SELECT tenant_id,id,$3,clock_timestamp(),$4,$5 FROM connector_installations
        WHERE tenant_id=$1 AND id=$2 AND document->'permissions' ? $3 AND document->'granted' ? $3`,
        [context.tenantId, connectionId, capability, result.ok, result],
      );
      if (!saved.rowCount) throw new Error('Connection capability unavailable');
    });
  };
}
