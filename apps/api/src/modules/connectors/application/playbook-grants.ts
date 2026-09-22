import type { InstalledConnection } from '#modules/connectors/domain/installation';
import type { TenantContext } from '#modules/identity/index';

export interface PlaybookGrantSource {
  connection: InstalledConnection;
  targets: { id: string; label: string }[];
}

/** Reads current connections and mapped orders. Mutation reads hold connection locks through commit. */
export type PlaybookGrantReader = (
  context: TenantContext,
  lock: boolean,
) => Promise<PlaybookGrantSource[]>;
