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
  list(
    context: TenantContext,
    query: {
      q: string;
      kind?: RecordKind | undefined;
      connectionId?: string | undefined;
    },
  ): Promise<{
    items: RecordSummary[];
    coverage: { customer: 'unavailable'; return: 'unavailable' };
  }>;
  get(
    context: TenantContext,
    kind: RecordKind,
    id: string,
  ): Promise<RecordDetail | null>;
}
