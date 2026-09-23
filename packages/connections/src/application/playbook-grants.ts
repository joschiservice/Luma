import type { TenantContext } from '@luma/identity';

import type { InstalledConnection } from '../domain/installation.js';

export interface PlaybookGrantSource {
  connection: InstalledConnection;
  targets: { id: string; label: string }[];
}

/** Reads current connections and mapped orders. Mutation reads hold connection locks through commit. */
export type PlaybookGrantReader = (
  context: TenantContext,
  lock: boolean,
) => Promise<PlaybookGrantSource[]>;
