import type { TenantContext } from '@luma/identity';
import {
  IdentityError,
  requirePermission,
  requireTenant,
} from '@luma/identity';
import type { OperationalMetricRead } from '@luma/platform';

import type {
  MeasurementEvent,
  MeasurementFact,
  MeasurementScope,
  ResolutionMetricItem,
} from '../domain/measurement.js';

export interface MeasurementCommand {
  id: string;
  expectedRevision: number;
  fact: MeasurementFact;
}

export interface MeasurementHistory {
  items: MeasurementEvent[];
  nextRevision: number | null;
  revision: number;
}

export interface MeasurementStore {
  /** Appends an immutable, evidence-owned fact under incident and event locks; identical retries return the original event. */
  append(
    context: TenantContext,
    incidentId: string,
    input: MeasurementCommand,
  ): Promise<MeasurementEvent>;
  /** Reads up to 100 facts after a revision and the current head in one tenant snapshot. */
  history(
    context: TenantContext,
    incidentId: string,
    after: number,
  ): Promise<MeasurementHistory>;
}

export interface MeasurementService {
  /** Records an assessment after a fresh `issues.manage` check; conflicting revisions return 409. */
  append(
    context: TenantContext,
    incidentId: string,
    input: unknown,
  ): Promise<MeasurementEvent>;
  /** Reads the evidence ledger; requires `issues.read`. */
  history(
    context: TenantContext,
    incidentId: string,
    after: number,
  ): Promise<MeasurementHistory>;
}

/** Reads a bounded incident cohort from the supplied tenant transaction. */
export type ResolutionMetricReader = (
  tenantId: string,
  asOf: string,
  scope?: MeasurementScope,
) => Promise<OperationalMetricRead<ResolutionMetricItem>[]>;

/** Applies refreshed tenant/actor authorization before reading or recording measurement facts. */
export function createMeasurementService(deps: {
  store: MeasurementStore;
  refreshContext(context: TenantContext): Promise<TenantContext>;
  parse(input: unknown): MeasurementCommand;
}): MeasurementService {
  async function authorized(context: TenantContext, write: boolean) {
    requireTenant(context, context.tenantId);
    const fresh = await deps.refreshContext(context);
    requireTenant(fresh, context.tenantId);
    if (fresh.actor.id !== context.actor.id)
      throw new IdentityError(403, 'FORBIDDEN', 'Actor changed');
    requirePermission(fresh, write ? 'issues.manage' : 'issues.read');

    return fresh;
  }

  return {
    append: async (context, incidentId, input) =>
      deps.store.append(
        await authorized(context, true),
        incidentId,
        deps.parse(input),
      ),
    history: async (context, incidentId, after) =>
      deps.store.history(await authorized(context, false), incidentId, after),
  };
}
