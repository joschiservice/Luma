import type { ActionDiff } from '@luma/connections';
import type { Permission, TenantContext } from '@luma/identity';
import type { ReplenishmentDecision } from '@luma/procurement';

import type {
  DecisionAssignment,
  DecisionCandidate as BaseDecisionCandidate,
  DecisionDomain,
  DecisionItem as BaseDecisionItem,
  DecisionOwner,
  DecisionReason,
  DecisionView,
} from '../domain/decision-item.js';
import type { SupplierCommitmentDecision } from '../domain/decisions.js';
import type {
  CollectionGroupedResult,
  CollectionListParameters,
} from './collections.js';

export type DecisionItem = BaseDecisionItem & { diff?: ActionDiff | null };

export type DecisionCandidate = BaseDecisionCandidate & {
  diff?: ActionDiff | null;
};

/** An owner that lists its own decisions for the reader. It must not read providers. */
export interface DecisionProvider {
  id: string;
  label: string;
  /**
   * The read permission for the owner's area. The queue doesn't ask the owner, and leaves it out
   * of `sources`, when the reader lacks it.
   */
  permission?: Permission;
  pending(context: TenantContext): Promise<DecisionCandidate[]>;
}

export interface DecisionQuery extends CollectionListParameters {
  view: DecisionView;
  domain?: DecisionDomain | undefined;
  reason?: DecisionReason | undefined;
  /** Searches titles; it may name people or records and is never logged. */
  q?: string | undefined;
  /** `urgency` by default; `requested` is how long the decision has waited. */
  sort?: 'urgency' | 'deadline' | 'requested' | undefined;
  direction?: 'asc' | 'desc' | undefined;
  cursor?: string | undefined;
  /** Reads only this decision. */
  id?: string | undefined;
  /** Page size, 1 to 100. */
  limit: number;
}

export interface DecisionList extends CollectionGroupedResult {
  schemaVersion: 1;
  asOf: string;
  items: DecisionItem[];
  nextCursor: string | null;
  totalCount: number;
  /** Items before this page in the same view and filters. */
  offset: number;
  counts: {
    views: Record<DecisionView, number>;
    domains: Record<DecisionDomain, number>;
    reasons: Record<DecisionReason, number>;
  };
  /**
   * Owners that failed to answer are `unavailable`; their decisions are missing, not resolved.
   * Owners whose area the reader can't read are left out, with their decisions.
   */
  sources: { id: string; label: string; state: 'available' | 'unavailable' }[];
}

/** A decision contributed by a workspace app; the host adds the app ID to its owner. */
export type AppOwnedDecision = Omit<DecisionCandidate, 'owner'> & {
  owner: DecisionOwner extends infer O
    ? O extends { appId: string }
      ? Omit<O, 'appId'>
      : never
    : never;
};

/** Lists supplier-lifecycle items that need a person; see the procurement owner. */
export type SupplierCommitmentDecisionReader = (
  context: TenantContext,
) => Promise<SupplierCommitmentDecision[]>;

/** Lists the replenishment proposals that wait for approval; see the procurement owner. */
export type ReplenishmentDecisionReader = (
  context: TenantContext,
) => Promise<ReplenishmentDecision[]>;

/**
 * Reads the decisions across owners that need a person, ranked by explicit urgency rules.
 * Responses go through each owner's review; the queue never decides anything. Issue decisions
 * need `issues.read` and owners' decisions their provider's permission; hidden decisions are
 * left out of items and counts alike, and record links the reader can't open are null.
 */
export interface DecisionQueue {
  /** Rejects a cursor produced by another view, filter or page size with a 400 error. */
  list(context: TenantContext, query: DecisionQuery): Promise<DecisionList>;
  /** Returns current work or an authorized persisted outcome for retained decision links. */
  find(context: TenantContext, id: string): Promise<DecisionItem | null>;
}

/** Changes who looks after a decision. Implemented by the resolution owner. */
export interface DecisionAssignments {
  assign(
    context: TenantContext,
    input: { decisionId: string; assigneeId: string | null; revision: number },
  ): Promise<{ decisionId: string; assignment: DecisionAssignment }>;
}
