import type { ConnectionProvider } from '@luma/connections';
import type { IdentityService, TenantContext } from '@luma/identity';
import type { FastifyInstance } from 'fastify';

import type { AppDefinition } from './contracts.js';

/** Validates unique app and connection identities and exposes immutable registration snapshots. */
export function createAppRegistry(definitions: readonly AppDefinition[] = []) {
  const apps = new Map<string, AppDefinition>();
  const targets = new Map<string, ConnectionProvider>();
  for (const definition of definitions) {
    const { manifest, connector } = definition;
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(manifest.id) || apps.has(manifest.id))
      throw new Error('Invalid or duplicate app ID');
    if (connector && connector.appId !== manifest.id)
      throw new Error('Connector belongs to a different app');
    const snapshot = { ...definition, manifest: structuredClone(manifest) };
    apps.set(manifest.id, snapshot);
    for (const target of connector?.targets ?? []) {
      if (targets.has(target)) throw new Error('Duplicate connection type');
      targets.set(target, connector!);
    }
  }

  return {
    /** Returns catalog metadata without exposing implementation functions. */
    list: () => [...apps.values()].map((a) => structuredClone(a.manifest)),
    /** Returns a trusted app contribution, or undefined if its package is absent. */
    get: (id: string) => apps.get(id),
    /** Resolves the app contribution that owns a connection target. */
    provider: (kind: string) => targets.get(kind),
    /** Lists connector contributions for capability runtime composition. */
    providers: () =>
      [...apps.values()].flatMap((a) => (a.connector ? [a.connector] : [])),
    /** Lists apps that contribute decisions to the Needs you queue. */
    decisionSources: () =>
      [...apps.values()].flatMap((a) =>
        a.decisions
          ? [
              {
                appId: a.manifest.id,
                name: a.manifest.name,
                decisions: (context: TenantContext) => a.decisions!(context),
              },
            ]
          : [],
      ),
    /** Lists the case workflows installed apps contribute. */
    workflowSources: () => [...apps.values()].flatMap((a) => a.workflows ?? []),
    /** Registers app-owned routes after host identity guards are attached. */
    registerHttp(server: FastifyInstance, identity?: IdentityService) {
      for (const app of apps.values()) app.registerHttp?.(server, identity);
    },
    /** Checks app deployment resources; an empty registry is ready. */
    async ready() {
      return (
        await Promise.all([...apps.values()].map((a) => a.ready?.() ?? true))
      ).every(Boolean);
    },
  };
}

export type AppRegistry = ReturnType<typeof createAppRegistry>;
