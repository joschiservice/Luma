import type { TenantContext } from '@luma/identity';
import {
  IdentityError,
  requirePermission,
  WorkspaceInactiveError,
} from '@luma/identity';

import type {
  AutoLinkInput,
  AutoLinkPair,
  AutoLinkPreview,
  AutoLinkRule,
} from '../domain/automatic-links.js';
import type { SyncConnection } from './ports.js';

/** Tenant-scoped rules and evidence reads; apply rechecks evidence atomically with remapping. */
export interface AutoLinkStore {
  scopes(): Promise<string[]>;
  list(tenantId: string): Promise<AutoLinkRule[]>;
  due(tenantId: string): Promise<AutoLinkRule[]>;
  connections(tenantId: string): Promise<SyncConnection[]>;
  save(context: TenantContext, input: AutoLinkInput): Promise<AutoLinkRule>;
  preview(tenantId: string, pair: AutoLinkPair): Promise<AutoLinkPreview>;
  apply(context: TenantContext, ruleId: string): Promise<void>;
  block(
    tenantId: string,
    ruleId: string,
    revision: number,
    state: 'blocked' | 'failed',
  ): Promise<void>;
}

/** Configuration and read-only preview. Membership is refreshed before every operation. */
export function createAutoLinkService(deps: {
  store: AutoLinkStore;
  refreshContext(context: TenantContext): Promise<TenantContext>;
}) {
  async function manager(context: TenantContext) {
    const fresh = await deps.refreshContext(context);
    requirePermission(fresh, 'sync.manage');

    return fresh;
  }

  async function validate(tenantId: string, pair: AutoLinkPair) {
    const connections = await deps.store.connections(tenantId);
    const target = connections.find(
      (item) => item.id === pair.targetConnectionId,
    );
    const source = connections.find(
      (item) => item.id === pair.sourceConnectionId,
    );
    if (!target || !source)
      throw new IdentityError(404, 'NOT_FOUND', 'Connection not found');
    if (target.id === source.id)
      throw new IdentityError(
        422,
        'CONFLICT',
        'Choose two different connections',
      );
    if (
      pair.kind === 'order' &&
      (target.provider !== 'shopify' || source.provider !== 'jtl')
    )
      throw new IdentityError(
        422,
        'CONFLICT',
        'Order rules match a JTL reference to an order in one Shopify store',
      );
  }

  return {
    /** Lists rules and their most recent outcomes for workspace members. */
    async autoLinkRules(context: TenantContext) {
      const fresh = await deps.refreshContext(context);

      return deps.store.list(fresh.tenantId);
    },
    /** Previews current evidence without changing identities. Requires Manage imports. */
    async previewAutoLinks(context: TenantContext, pair: AutoLinkPair) {
      const fresh = await manager(context);
      await validate(fresh.tenantId, pair);

      return deps.store.preview(fresh.tenantId, pair);
    },
    /** Saves an audited, revision-checked rule and continues with the caller's access. */
    async saveAutoLinkRule(context: TenantContext, input: AutoLinkInput) {
      const fresh = await manager(context);
      await validate(fresh.tenantId, input);

      return deps.store.save(fresh, input);
    },
  };
}

/** Runs due rules with their configuring person's current access; failures remain visible. */
export function createAutoLinkRunner(deps: {
  store: AutoLinkStore;
  resolveContext(
    principalId: string,
    tenantId: string,
    requestId: string,
  ): Promise<TenantContext>;
  log(message: string, error?: unknown): void;
}) {
  return {
    scopes: () => deps.store.scopes(),
    async tick(tenantId: string) {
      for (const rule of await deps.store.due(tenantId)) {
        try {
          const context = await deps.resolveContext(
            rule.principalId,
            tenantId,
            `automatic-link:${rule.id}`,
          );
          requirePermission(context, 'sync.manage');
          await deps.store.apply(context, rule.id);
        } catch (error) {
          // A suspended workspace leaves its rules due; they run once it is active again.
          if (error instanceof WorkspaceInactiveError) return;
          const denied = error instanceof IdentityError;
          if (!denied) deps.log('Automatic linking failed; retrying.', error);
          await deps.store.block(
            tenantId,
            rule.id,
            rule.revision,
            denied ? 'blocked' : 'failed',
          );
        }
      }
    },
  };
}

export type AutoLinkService = ReturnType<typeof createAutoLinkService>;

export type AutoLinkRunner = ReturnType<typeof createAutoLinkRunner>;
