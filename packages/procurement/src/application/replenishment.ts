import type { TenantContext } from '@luma/identity';
import type { ReplenishmentPositionQuery } from '@luma/workflows';

import type { ReplenishmentRule } from '../domain/replenishment.js';
import type { ReplenishmentApprovalContext } from '../domain/replenishment-review-context.js';

export interface ReplenishmentActivation extends ReplenishmentRule {
  principalId: string;
  versionDigest: string;
  artifactDigest: string;
  policyVersion: string;
  reviewedAt: string;
  sku: string;
  supplier: string;
  active: boolean;
  revokedAt?: string;
  revokedBy?: string;
}

export interface ReplenishmentStock {
  positionId: string;
  connectionId: string;
  sku: string;
  unit: string;
  available: number | null;
  observedAt: string;
  observationId: string;
  deleted: boolean;
}

/** Stores immutable grants and serializes overlapping replenishment actions. */
export interface ReplenishmentStore {
  /** Reads frozen approval facts; with an input, inserts once and returns the original on retry. */
  reviewContext(
    context: TenantContext,
    runId: string,
    input?: ReplenishmentApprovalContext,
  ): Promise<ReplenishmentApprovalContext | null>;
  /** Checks whether any non-deleted stock has been projected without loading stock records. */
  hasStock(context: TenantContext): Promise<boolean>;
  /** Reads only the named positions. Omit a connection to read every source of that position. Empty scopes read nothing. */
  stocksFor(
    context: TenantContext,
    positions: readonly { positionId: string; connectionId?: string }[],
  ): Promise<ReplenishmentStock[]>;
  /** Browses at most 50 non-deleted stock choices, with server-side SKU search and a continuation cursor. */
  browseStocks(
    context: TenantContext,
    query: ReplenishmentPositionQuery,
  ): Promise<{ positions: ReplenishmentStock[]; nextCursor: string | null }>;
  list(context: TenantContext): Promise<ReplenishmentActivation[]>;
  save(
    context: TenantContext,
    activation: ReplenishmentActivation,
  ): Promise<ReplenishmentActivation>;
  revoke(context: TenantContext, id: string): Promise<ReplenishmentActivation>;
  claim(
    context: TenantContext,
    positionId: string,
    sku: string,
    runId: string,
  ): Promise<boolean>;
  release(context: TenantContext, runId: string): Promise<void>;
}
