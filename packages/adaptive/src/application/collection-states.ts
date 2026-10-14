import type { TenantContext } from '@luma/identity';
import {
  IdentityError,
  requireChangesAllowed,
  requireTenant,
} from '@luma/identity';

import type {
  CollectionMemberStateDocument,
  CollectionStateDomain,
  CollectionStateResponse,
  StoredCollectionState,
} from '../domain/collection-states.js';

export interface CollectionStatesStore {
  get(
    tenantId: string,
    userId: string,
    domain: CollectionStateDomain,
  ): Promise<StoredCollectionState | null>;
  /**
   * Stores the state when `sequence` is higher than the stored one and returns what is stored
   * afterwards, so a late, older save never replaces a newer one.
   */
  save(
    tenantId: string,
    userId: string,
    domain: CollectionStateDomain,
    value: StoredCollectionState,
  ): Promise<StoredCollectionState>;
  remove(
    tenantId: string,
    userId: string,
    domain: CollectionStateDomain | null,
  ): Promise<number>;
}

export interface CollectionStatesDependencies {
  store: CollectionStatesStore;
  refreshContext(context: TenantContext): Promise<TenantContext>;
  validation: {
    /** Parses a list identifier; throws a 404 for unknown lists. */
    domain(value: unknown): CollectionStateDomain;
    state(value: unknown): CollectionMemberStateDocument;
    /** Permission needed to read the list, or null when every member may. */
    permission(domain: CollectionStateDomain): string | null;
  };
  now(): Date;
}

function response(
  domain: CollectionStateDomain,
  stored: StoredCollectionState | null,
): CollectionStateResponse {
  return {
    domain,
    state: stored?.state ?? null,
    sequence: stored?.sequence ?? 0,
    updatedAt: stored?.updatedAt ?? null,
  };
}

/**
 * Keeps each member's last list state per page, synced across devices. Reads and saves require
 * read access to the list; saves are refused in read-only support views. The state holds view
 * references and filter values, never records.
 */
export function createCollectionStatesService(
  deps: CollectionStatesDependencies,
) {
  async function authorize(
    context: TenantContext,
    domain: CollectionStateDomain | null,
    write: boolean,
  ) {
    requireTenant(context, context.tenantId);
    const fresh = await deps.refreshContext(context);
    requireTenant(fresh, context.tenantId);
    if (fresh.actor.id !== context.actor.id)
      throw new IdentityError(403, 'FORBIDDEN', 'Sign in again to continue.');
    if (write) requireChangesAllowed(fresh);
    const permission = domain ? deps.validation.permission(domain) : null;
    if (permission && !fresh.permissions.has(permission))
      throw new IdentityError(
        403,
        'FORBIDDEN',
        'Your role cannot open this list.',
      );

    return fresh;
  }

  return {
    async get(context: TenantContext, raw: string) {
      const domain = deps.validation.domain(raw);
      const fresh = await authorize(context, domain, false);

      return response(
        domain,
        await deps.store.get(fresh.tenantId, fresh.actor.id, domain),
      );
    },
    async save(
      context: TenantContext,
      raw: string,
      input: { state: unknown; sequence: number },
    ) {
      const domain = deps.validation.domain(raw);
      const fresh = await authorize(context, domain, true);
      if (!Number.isSafeInteger(input.sequence) || input.sequence < 1)
        throw new IdentityError(
          422,
          'VALIDATION_ERROR',
          'The save sequence must be a positive whole number.',
        );
      const stored = await deps.store.save(
        fresh.tenantId,
        fresh.actor.id,
        domain,
        {
          state: deps.validation.state(input.state),
          sequence: input.sequence,
          updatedAt: deps.now().toISOString(),
        },
      );

      return response(domain, stored);
    },
    async reset(context: TenantContext, raw: string) {
      const domain = deps.validation.domain(raw);
      const fresh = await authorize(context, domain, true);
      await deps.store.remove(fresh.tenantId, fresh.actor.id, domain);

      return response(domain, null);
    },
    async resetAll(context: TenantContext) {
      const fresh = await authorize(context, null, true);

      return {
        removed: await deps.store.remove(fresh.tenantId, fresh.actor.id, null),
      };
    },
  };
}

export type CollectionStates = ReturnType<typeof createCollectionStatesService>;
