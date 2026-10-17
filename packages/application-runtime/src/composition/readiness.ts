import { requireWorkspaceAppsReadable } from '@luma/app-host';
import { connectionRuntimeReady } from '@luma/connections/composition';
import type { Pool } from 'pg';

/** Checks identity and connector runtime grants without requiring tenant data access. */
export function createReadinessCheck(
  identityReady: () => Promise<boolean>,
  connectionPool?: Pool,
  appsReady?: () => Promise<boolean>,
) {
  return async () => {
    if (!(await identityReady())) return false;
    if (connectionPool) {
      if (!(await connectionRuntimeReady(connectionPool))) return false;
      await requireWorkspaceAppsReadable(connectionPool);
      if (appsReady && !(await appsReady())) return false;
    }

    return true;
  };
}
