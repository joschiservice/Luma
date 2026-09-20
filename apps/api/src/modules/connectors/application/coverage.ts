import type { ConnectionCoverage } from '#modules/connectors/domain/coverage';
import type { TenantContext } from '#modules/identity/index';

export type { ConnectionCoverage } from '#modules/connectors/domain/coverage';

/**
 * Reads all current tenant connections, ordered by label then ID.
 * Pass an ISO timestamp as `asOf`; observations after that instant are excluded.
 * Connection status and permissions reflect their current state, not historical state.
 */
export type CoverageReader = (
  context: TenantContext,
  asOf: string,
) => Promise<ConnectionCoverage[]>;
