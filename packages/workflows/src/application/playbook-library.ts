import type {
  PlaybookGrantReader,
  PlaybookGrantSource,
} from '@luma/connections';
import type { TenantContext } from '@luma/identity';
import { IdentityError, requireRole, requireTenant } from '@luma/identity';
import { currentPolicyVersion } from '@luma/policies';

import type { PlaybookVersion } from '../domain/playbook.js';
import type {
  ActivatePlaybook,
  PlaybookActivationView,
  PlaybookDetail,
  PlaybookRunView,
  PlaybookSummary,
} from '../domain/playbook-library.js';
import { presentPlaybook } from '../domain/playbook-presentation.js';
import type { PlaybookService } from './playbook.js';

export interface PlaybookLibraryStore {
  /** Reads immutable published versions in this workspace. */
  versions(
    context: TenantContext,
    definitionId?: string,
  ): Promise<PlaybookVersion[]>;
  /** Reads activation history and its current admission status. */
  activations(
    context: TenantContext,
    definitionId: string,
  ): Promise<PlaybookActivationView[]>;
  /** Reads up to 50 recent runs with independently classified evidence. */
  runs(
    context: TenantContext,
    definitionId: string,
  ): Promise<PlaybookRunView[]>;
  /** Returns the reviewed request, or null when the id has not been used. */
  review(
    context: TenantContext,
    id: string,
  ): Promise<{
    definitionId: string;
    actorId: string;
    request: ActivatePlaybook;
  } | null>;
  /** Records the exact version, scope and approving administrator before activation commits. */
  recordReview(
    context: TenantContext,
    definitionId: string,
    request: ActivatePlaybook,
  ): Promise<void>;
}

export interface PlaybookLibraryScope {
  store: PlaybookLibraryStore;
  grants: PlaybookGrantReader;
  commands: Pick<PlaybookService, 'activate' | 'revoke'>;
}

export interface PlaybookLibraryDependencies extends PlaybookLibraryScope {
  /** Serializes management commands for a tenant and commits admission and review records atomically. */
  transaction<T>(
    context: TenantContext,
    operation: (scope: PlaybookLibraryScope) => Promise<T>,
  ): Promise<T>;
  refreshContext(context: TenantContext): Promise<TenantContext>;
}
const conflict = (message: string): never => {
  throw new IdentityError(409, 'CONFLICT', message);
};
const missing = (): never => {
  throw new IdentityError(404, 'NOT_FOUND', 'Workflow not found');
};
const equalRequest = (left: ActivatePlaybook, right: ActivatePlaybook) =>
  left.id === right.id &&
  left.version === right.version &&
  left.reviewedDigest === right.reviewedDigest &&
  left.policyVersion === right.policyVersion &&
  left.connectionId === right.connectionId &&
  left.connectionVersion === right.connectionVersion &&
  left.scopeReviewed === right.scopeReviewed &&
  [...left.targetIds].sort().join() === [...right.targetIds].sort().join();

/** Lists what a connection needs before an order correction can use it. Empty when eligible. */
export function connectionBlockers({
  connection,
  targets,
}: PlaybookGrantSource): string[] {
  const blockers: string[] = [];
  if (connection.status !== 'active')
    blockers.push('Validate or reconnect this connection before activation.');
  for (const permission of [
    'orders.shipping-method.write',
    'orders.read',
  ] as const)
    if (
      !connection.permissions.includes(permission) ||
      !connection.granted.includes(permission)
    )
      blockers.push(`Grant ${permission} in Connections and validate access.`);
  if (!targets.length)
    blockers.push('Ingest and map at least one order on this connection.');

  return blockers;
}

/** Provides member-readable playbooks and atomic administrator activation commands. */
export function createPlaybookLibrary(deps: PlaybookLibraryDependencies) {
  async function authorize(context: TenantContext, write = false) {
    const fresh = await deps.refreshContext(context);
    requireTenant(fresh, context.tenantId);
    requireRole(
      fresh,
      write ? ['owner', 'admin'] : ['owner', 'admin', 'member'],
    );
    if (fresh.actor.id !== context.actor.id)
      throw new IdentityError(403, 'FORBIDDEN', 'Sign in again to continue.');

    return fresh;
  }

  async function detail(
    context: TenantContext,
    definitionId: string,
    scope: PlaybookLibraryScope,
    lock = false,
  ): Promise<PlaybookDetail> {
    const [published, activations, sources] = await Promise.all([
      scope.store.versions(context, definitionId),
      scope.store.activations(context, definitionId),
      scope.grants(context, lock),
    ]);
    if (!published.length) return missing();
    published.sort((a, b) => {
      const left = a.version.split('.').map(Number),
        right = b.version.split('.').map(Number);

      return (
        right[0]! - left[0]! || right[1]! - left[1]! || right[2]! - left[2]!
      );
    });
    const versions = published.map(presentPlaybook);
    for (const version of versions)
      version.systems = [
        ...new Set(
          sources
            .filter(
              ({ connection }) =>
                connection.permissions.includes(
                  version.capability as 'orders.shipping-method.write',
                ) &&
                connection.granted.includes(
                  version.capability as 'orders.shipping-method.write',
                ),
            )
            .map(({ connection }) => connection.target.kind),
        ),
      ];
    const latest = versions[0]!;
    const connections = sources.map(({ connection, targets }) => ({
      id: connection.id,
      label: connection.label,
      version: connection.version,
      system: connection.target.kind,
      blockers: connectionBlockers({ connection, targets }),
      targets,
    }));
    const blockers = [...latest.blockers];
    if (!connections.some((c) => c.blockers.length === 0))
      blockers.push(
        'No eligible connection. Open Connections to validate permissions and mapped orders.',
      );
    const activeVersions = [
      ...new Set(activations.filter((a) => a.active).map((a) => a.version)),
    ];
    const summary: PlaybookSummary = {
      id: definitionId,
      name: published[0]!.definition.name,
      purpose: published[0]!.definition.intent,
      capability: latest.capability,
      issueType: latest.issueType,
      systems: latest.systems,
      availableVersion: latest.version,
      activeVersions,
      blockers,
      status: activeVersions.length
        ? 'active'
        : blockers.length
          ? 'unavailable'
          : activations.length
            ? 'revoked'
            : 'inactive',
    };

    return {
      summary,
      versions,
      connections,
      activations,
      policyVersion: currentPolicyVersion,
      principalId: context.actor.id,
      canManage: context.actor.role !== 'member',
      evaluationEvidence: 'unavailable',
    };
  }

  return {
    async list(context: TenantContext) {
      context = await authorize(context);
      const versions = await deps.store.versions(context);
      const ids = [...new Set(versions.map((v) => v.definition.id))];

      return Promise.all(
        ids.map(async (id) => (await detail(context, id, deps)).summary),
      );
    },
    async detail(context: TenantContext, id: string) {
      return detail(await authorize(context), id, deps);
    },
    async runs(context: TenantContext, id: string) {
      context = await authorize(context);
      if (!(await deps.store.versions(context, id)).length) return missing();

      return deps.store.runs(context, id);
    },
    async activate(
      context: TenantContext,
      id: string,
      request: ActivatePlaybook,
    ) {
      context = await authorize(context, true);

      return deps.transaction(context, async (scope) => {
        context = await authorize(context, true);
        const prior = await scope.store.review(context, request.id);
        if (
          prior &&
          (prior.definitionId !== id ||
            prior.actorId !== context.actor.id ||
            !equalRequest(prior.request, request))
        )
          return conflict(
            'This request ID already has another scope. Reload and review a new request.',
          );
        const view = await detail(context, id, scope, true);
        const existing = view.activations.find((a) => a.id === request.id);
        if (existing) {
          if (!prior || !existing.active)
            return conflict(
              'This activation already exists or was revoked. Review a new activation.',
            );

          return existing;
        }
        const version = view.versions.find(
          (v) => v.version === request.version,
        );
        if (
          !version ||
          version.digest !== request.reviewedDigest ||
          !request.scopeReviewed
        )
          return conflict(
            'The reviewed version changed. Reload and review its exact digest.',
          );
        if (version.blockers.length)
          return conflict(version.blockers.join(' '));
        if (request.policyVersion !== currentPolicyVersion)
          return conflict(
            'Policy changed. Reload and review the current approval behavior.',
          );
        const connection = view.connections.find(
          (c) => c.id === request.connectionId,
        );
        if (!connection)
          throw new IdentityError(404, 'NOT_FOUND', 'Connection not found');
        if (connection.version !== request.connectionVersion)
          return conflict(
            'Connection grants changed. Reload and review the current scope.',
          );
        if (connection.blockers.length)
          return conflict(connection.blockers.join(' '));
        if (
          !request.targetIds.length ||
          request.targetIds.some(
            (id) => !connection.targets.some((t) => t.id === id),
          )
        )
          return conflict(
            'An order is not mapped to this connection. Refresh the scope and select mapped orders.',
          );
        if (
          view.activations.some(
            (a) =>
              a.active &&
              a.grants.principalIds.includes(context.actor.id) &&
              a.grants.connectionIds.includes(connection.id) &&
              a.grants.targetIds.some((id) => request.targetIds.includes(id)),
          )
        )
          return conflict(
            'An active version already covers this scope. Revoke it before granting a replacement.',
          );
        await scope.store.recordReview(context, id, request);
        await scope.commands.activate(context, {
          id: request.id,
          definitionId: id,
          version: request.version,
          policyVersion: currentPolicyVersion,
          grants: {
            principalIds: [context.actor.id],
            connectionIds: [connection.id],
            targetIds: [...request.targetIds].sort(),
          },
        });

        return (await scope.store.activations(context, id)).find(
          (a) => a.id === request.id,
        )!;
      });
    },
    async revoke(
      context: TenantContext,
      id: string,
      activationId: string,
      artifactDigest: string,
    ) {
      context = await authorize(context, true);

      return deps.transaction(context, async (scope) => {
        context = await authorize(context, true);
        const activation = (await scope.store.activations(context, id)).find(
          (a) => a.id === activationId,
        );
        if (!activation) return missing();
        if (activation.artifactDigest !== artifactDigest)
          return conflict('Activation changed. Reload before revoking.');
        await scope.commands.revoke(context, activationId);

        return { ...activation, active: false };
      });
    },
  };
}

export type PlaybookLibrary = ReturnType<typeof createPlaybookLibrary>;
