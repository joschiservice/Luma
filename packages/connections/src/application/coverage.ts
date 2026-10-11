import type { TenantContext } from '@luma/identity';

import type { ConnectionCoverage } from '../domain/coverage.js';

/**
 * Reads all current tenant connections, ordered by label then ID.
 * Pass an ISO timestamp as `asOf`; observations after that instant are excluded.
 * Connection status and permissions reflect their current state, not historical state.
 */
export type CoverageReader = (
  context: TenantContext,
  asOf: string,
) => Promise<ConnectionCoverage[]>;
