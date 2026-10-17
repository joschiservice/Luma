import type { TenantDatabase } from '@luma/platform';

import type { WorkspaceSettings } from '../domain/settings.js';

/**
 * Reads the detection settings a workspace saved, without defaults: undefined when it saved
 * none, so detection keeps its own defaults. Reads in the given tenant only.
 */
export function createDetectionSettingsReader(database: TenantDatabase) {
  return (tenantId: string): Promise<WorkspaceSettings['detection']> =>
    database.transaction(
      tenantId,
      async (tx) =>
        (
          await tx.query<{
            detection: NonNullable<WorkspaceSettings['detection']> | null;
          }>('SELECT detection FROM workspace_settings WHERE tenant_id=$1', [
            tenantId,
          ])
        ).rows[0]?.detection ?? undefined,
    );
}
