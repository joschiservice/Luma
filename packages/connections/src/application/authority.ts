import type { TenantContext } from '@luma/identity';
import {
  IdentityError,
  requirePermission,
  requireTenant,
} from '@luma/identity';

import type {
  AuthorityConnection,
  AuthorityGroup,
  AuthorityOverrides,
  FactAuthority,
} from '../domain/authority.js';
import { authorityGroups, resolveAuthority } from '../domain/authority.js';

interface AuthorityChange {
  commandId: string;
  revision: number;
  group: AuthorityGroup;
  connectionId: string | null;
}

export interface AuthorityEvent extends AuthorityChange {
  actorId: string;
  previousConnectionId: string | null;
  occurredAt: string;
}

export interface AuthorityState {
  revision: number;
  overrides: AuthorityOverrides;
  connections: AuthorityConnection[];
}

export interface AuthoritySnapshot {
  revision: number;
  groups: FactAuthority[];
  connections: AuthorityConnection[];
}

/** Shared authority reader for detection, diagnosis, proposals and compared facts. Reads never rewrite observations. */
export interface AuthorityReader {
  read(context: TenantContext): Promise<AuthoritySnapshot>;
}

/** Workspace overrides are revision-checked, retry-safe and audited. */
export interface AuthoritySettings extends AuthorityReader {
  change(
    context: TenantContext,
    input: AuthorityChange,
  ): Promise<AuthorityEvent>;
  history(context: TenantContext): Promise<AuthorityEvent[]>;
}

export interface AuthorityRepository {
  read(tenantId: string): Promise<AuthorityState>;
  /** Atomically validates the connection and revision, saves the override and appends its immutable receipt. */
  change(
    tenantId: string,
    actorId: string,
    input: AuthorityChange,
  ): Promise<AuthorityEvent>;
  history(tenantId: string): Promise<AuthorityEvent[]>;
}

/** Creates authority access with refreshed settings permission for writes and tenant checks for every read. */
export function createAuthorityService(
  repository: AuthorityRepository,
  refreshContext: (context: TenantContext) => Promise<TenantContext>,
): AuthoritySettings {
  return {
    async read(context) {
      requireTenant(context, context.tenantId);
      const state = await repository.read(context.tenantId);

      return {
        revision: state.revision,
        connections: state.connections,
        groups: authorityGroups.map((group) =>
          resolveAuthority(group, state.connections, state.overrides),
        ),
      };
    },
    async change(context, input) {
      const fresh = await refreshContext(context);
      requireTenant(fresh, context.tenantId);
      if (fresh.actor.id !== context.actor.id)
        throw new IdentityError(403, 'FORBIDDEN', 'Actor changed');
      requirePermission(fresh, 'workspace.settings.manage');

      return repository.change(fresh.tenantId, fresh.actor.id, input);
    },
    async history(context) {
      requireTenant(context, context.tenantId);

      return repository.history(context.tenantId);
    },
  };
}
