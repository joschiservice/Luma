import type { TenantContext } from '@luma/identity';

import type { ReplenishmentRule } from '../domain/replenishment.js';

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
  stocks(context: TenantContext): Promise<ReplenishmentStock[]>;
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
