import { requireTenant } from '#modules/identity/index';
import type { TenantContext } from '#modules/identity/index';

import type { Incident } from '#modules/exceptions/application/detection';
import type { Diagnosis } from '#modules/exceptions/domain/diagnosis';
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
  diagnosis: Diagnosis | null;
}
export interface CaseOverview {
  attentionCount: number;
  activeCount: number;
  verifiedResolutions: number;
  prioritizedDecisions: CaseSummary[];
}
export interface CaseReader {
  overview(tenantId: string, start: string, end: string): Promise<CaseOverview>;
  list(
    tenantId: string,
    query: CaseQuery,
  ): Promise<{
    items: CaseSummary[];
    nextCursor: string | null;
    coverage: 'observed' | 'unobserved';
  }>;
  get(tenantId: string, id: string): Promise<CaseDetail | null>;
}
export function createCaseService(reader: CaseReader) {
  return {
    overview(context: TenantContext, start: string, end: string) {
      requireTenant(context, context.tenantId);
      return reader.overview(context.tenantId, start, end);
    },
    list(context: TenantContext, query: CaseQuery) {
      requireTenant(context, context.tenantId);
      return reader.list(context.tenantId, query);
    },
    get(context: TenantContext, id: string) {
      requireTenant(context, context.tenantId);
      return reader.get(context.tenantId, id);
    },
  };
}
export type CaseService = ReturnType<typeof createCaseService>;
