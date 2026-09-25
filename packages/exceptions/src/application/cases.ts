import type { TenantContext } from '@luma/identity';
import { requireTenant } from '@luma/identity';

import type { Diagnosis } from '../domain/diagnosis.js';
import type { Incident } from './detection.js';

export interface CaseQuery {
  view: 'needs_you' | 'active' | 'history';
  class?: Incident['exceptionClass'] | undefined;
  severity?: Incident['severity'] | undefined;
  state?: Incident['state'] | undefined;
  cursor?: string | undefined;
  limit: number;
}

export interface CaseSummary {
  schemaVersion: 1;
  id: string;
  revision: number;
  class: string;
  state: Incident['state'];
  severity: Incident['severity'];
  summary: string;
  subject: { kind: string; id: string; scope: string[] };
  sources: string[];
  detectedAt: string;
  lastActivityAt: string;
  attention: {
    required: boolean;
    reason: 'approval' | 'manual_intervention' | 'uncertainty' | null;
    explanation: string;
    requestedAt: string | null;
  };
  freshness: 'fresh' | 'stale' | 'unknown';
  diagnosisStatus: Diagnosis['status'];
  resolution: 'verified' | 'human_disposition' | null;
}

export interface CaseDetail extends CaseSummary {
  inventorySources?: { left: string | null; right: string | null } | null;
  productIdentities?: {
    source: string;
    title: string | null;
    sku: string | null;
  }[];
  diagnosis: Diagnosis | null;
}

export interface CaseOverview {
  attentionCount: number;
  activeCount: number;
  verifiedResolutions: number;
  prioritizedDecisions: CaseSummary[];
}

export interface CaseEvidenceQuery {
  cursor?: string | undefined;
  limit: number;
}

export interface CaseEvidencePage {
  schemaVersion: 1;
  items: (Diagnosis['provenance']['evidence'][number] & {
    completeness: 'complete' | 'incomplete' | 'unknown';
  })[];
  nextCursor: string | null;
}

export interface CaseReader {
  evidence(
    tenantId: string,
    id: string,
    query: CaseEvidenceQuery,
  ): Promise<CaseEvidencePage | null>;
  overview(tenantId: string, start: string, end: string): Promise<CaseOverview>;
  list(
    tenantId: string,
    query: CaseQuery,
  ): Promise<{
    totalCount: number;
    offset: number;
    items: CaseSummary[];
    nextCursor: string | null;
    coverage: 'observed' | 'unobserved';
  }>;
  get(tenantId: string, id: string): Promise<CaseDetail | null>;
}

/**
 * Creates case reads that require a resolved tenant context before accessing the supplied
 * reader.
 */
export function createCaseService(
  reader: CaseReader,
  productIdentities?: (
    tenantId: string,
    skuId: string,
  ) => Promise<NonNullable<CaseDetail['productIdentities']>>,
) {
  return {
    evidence(context: TenantContext, id: string, query: CaseEvidenceQuery) {
      requireTenant(context, context.tenantId);

      return reader.evidence(context.tenantId, id, query);
    },
    overview(context: TenantContext, start: string, end: string) {
      requireTenant(context, context.tenantId);

      return reader.overview(context.tenantId, start, end);
    },
    list(context: TenantContext, query: CaseQuery) {
      requireTenant(context, context.tenantId);

      return reader.list(context.tenantId, query);
    },
    async get(context: TenantContext, id: string) {
      requireTenant(context, context.tenantId);

      const item = await reader.get(context.tenantId, id);
      if (!item || item.subject.kind !== 'sku' || !productIdentities)
        return item;

      return {
        ...item,
        productIdentities: await productIdentities(
          context.tenantId,
          item.subject.id,
        ),
      };
    },
  };
}

export type CaseService = ReturnType<typeof createCaseService>;
