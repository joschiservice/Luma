import type { TenantContext } from '@luma/identity';
import { requireTenant } from '@luma/identity';
import { unavailable } from '@luma/platform';

import type { Diagnosis } from '../domain/diagnosis.js';
import type { Incident } from './detection.js';
import type { CaseOwner, createCaseOwners } from './owners.js';

/** One condition on an issues catalog field, as the API contract parsed it. */
export interface CaseCondition {
  field: string;
  op: string;
  value?: unknown;
  source?: string | undefined;
}

/** Conditions combined with AND (`all`) or OR (`any`). */
interface CaseWhere {
  match: 'all' | 'any';
  conditions: CaseCondition[];
}

/** A value of the field the list is grouped by; null is the group without a value. */
export type CaseGroupKey = string | number | boolean | null;

export interface CaseQuery {
  view: 'needs_you' | 'active' | 'history';
  ownerId?: string | undefined;
  class?: Incident['exceptionClass'] | undefined;
  severity?: Incident['severity'] | undefined;
  state?: Incident['state'] | undefined;
  /** Searches summaries and records; it may hold personal data and is never logged. */
  q?: string | undefined;
  where?: CaseWhere | undefined;
  group?:
    | { field: string; granularity?: 'day' | 'week' | 'month' | undefined }
    | undefined;
  /** Reads one group's rows, paged by `cursor` and `limit`, instead of every group. */
  groupKey?: CaseGroupKey | undefined;
  /** Rows per group when reading every group, 1 to 50. */
  groupLimit?: number | undefined;
  /** IANA zone for days and relative periods in conditions; UTC by default. */
  timeZone?: string | undefined;
  sort?: 'urgency' | 'detected' | 'lastActivity' | 'waitingSince' | undefined;
  direction?: 'asc' | 'desc' | undefined;
  cursor?: string | undefined;
  limit: number;
}

/** One group of a grouped issue list. */
export interface CaseGroup {
  key: CaseGroupKey;
  count: number;
  complete: boolean;
  itemIds: string[];
  nextCursor: string | null;
  sums: { field: string; currency: string | null; amount: string }[];
}

/** A page of the issue list, or every group's first rows of a grouped read. */
export interface CaseListPage {
  totalCount: number;
  offset: number;
  items: CaseSummary[];
  nextCursor: string | null;
  coverage: 'observed' | 'unobserved';
  groups?: CaseGroup[];
  groupsTruncated?: boolean;
}

/** @public Declaration emit names it in the inferred type of `createCases`. */
export interface CaseSummary {
  owner?: CaseOwner | null | undefined;
  schemaVersion: 1;
  id: string;
  revision: number;
  class: string;
  state: Incident['state'];
  severity: Incident['severity'];
  summary: string;
  subject: {
    label?: string | undefined;
    kind: string;
    id: string;
    scope: string[];
  };
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
  detectionLimits?:
    | {
        inventoryTolerance: string;
        propagationSeconds: number;
        oversellPropagationSeconds: number;
        stuckSeconds: number;
      }
    | undefined;
  inventorySources?: { left: string | null; right: string | null } | null;
  productIdentities?: {
    source: string;
    title: string | null;
    sku: string | null;
  }[];
  diagnosis: Diagnosis | null;
}

/** @public Declaration emit names it in the inferred type of `createCases`. */
export interface CaseOverview {
  attentionCount: number;
  activeCount: number;
  verifiedResolutions: number;
  /** Up to five verified cases completed in the overview window. */
  verifiedCases?: CaseSummary[];
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
  overview(
    tenantId: string,
    start: string,
    end: string,
    readAt?: string,
  ): Promise<CaseOverview>;
  /**
   * Reads one page of the list, or every group's first rows. `actorId` is the reader, whom an
   * owner condition's `me` names. Rejects malformed conditions and cursors from another query
   * with a 400 error.
   */
  list(
    tenantId: string,
    query: CaseQuery,
    actorId: string,
  ): Promise<CaseListPage>;
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
  owners?: ReturnType<typeof createCaseOwners>,
) {
  return {
    async assignOwner(
      context: TenantContext,
      id: string,
      input: { userId: string | null; revision: number },
    ) {
      if (!owners) throw unavailable('Case assignment is unavailable');

      return owners.assign(context, id, input);
    },
    /**
     * Gives a case nobody owns to `userId`, keeping any existing owner; see
     * `createCaseOwners().claim`.
     */
    async claimOwner(context: TenantContext, id: string, userId: string) {
      if (!owners) throw unavailable('Case assignment is unavailable');

      return owners.claim(context, id, userId);
    },
    evidence(context: TenantContext, id: string, query: CaseEvidenceQuery) {
      requireTenant(context, context.tenantId);

      return reader.evidence(context.tenantId, id, query);
    },
    overview(
      context: TenantContext,
      start: string,
      end: string,
      readAt?: string,
    ) {
      requireTenant(context, context.tenantId);

      return reader.overview(context.tenantId, start, end, readAt);
    },
    list(context: TenantContext, query: CaseQuery) {
      requireTenant(context, context.tenantId);

      return reader.list(context.tenantId, query, context.actor.id);
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
