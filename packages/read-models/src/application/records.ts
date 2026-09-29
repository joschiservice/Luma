import type { TenantContext } from '@luma/identity';

export type RecordKind =
  'order' | 'fulfillment' | 'position' | 'sku' | 'product' | 'issue';

export interface RecordSummary {
  kind: RecordKind;
  id: string;
  label: string;
  description: string;
  status: string;
  coverage: 'projected' | 'identity_only';
  sources: {
    connectionId: string;
    label: string;
    status: string;
    externalId: string | null;
    mappingMethod: string | null;
    observedAt: string | null;
    sourceUpdatedAt: string | null;
  }[];
  observedAt: string | null;
  sourceUpdatedAt: string | null;
}

export interface RecordDetail {
  record: RecordSummary;
  links: {
    kind: RecordKind;
    id: string;
    label: string;
    relationship: string;
  }[];
  snapshots: {
    connectionId: string;
    observedAt: string;
    sourceUpdatedAt: string | null;
    data: Record<string, unknown>;
  }[];
}

/** Reads current records and confirmed relationships for one tenant. */
export interface RecordExplorer {
  /** Resolves an exact source identity; multiple IDs indicate an ambiguous mapping. */
  resolve(
    context: TenantContext,
    query: { connectionId: string; externalId: string; kind: 'order' },
  ): Promise<{ ids: string[] }>;

  /**
   * Reads up to 50 matching records, most recently observed first. Rejects a cursor issued for
   * a different search with a 400 error.
   */
  list(
    context: TenantContext,
    query: {
      q: string;
      kind?: RecordKind | undefined;
      connectionId?: string | undefined;
      cursor?: string | undefined;
    },
  ): Promise<{
    items: RecordSummary[];
    nextCursor: string | null;
    coverage: { customer: 'unavailable'; return: 'unavailable' };
  }>;
  get(
    context: TenantContext,
    kind: RecordKind,
    id: string,
  ): Promise<RecordDetail | null>;
}
