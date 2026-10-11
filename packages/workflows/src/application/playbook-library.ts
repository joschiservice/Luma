import type {
  PlaybookGrantReader,
  PlaybookGrantSource,
} from '@luma/connections';
import type { Permission, TenantContext } from '@luma/identity';
import {
  hasPermission,
  IdentityError,
  requirePermission,
  requireTenant,
} from '@luma/identity';
import type { PolicyService } from '@luma/policies';
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
import type { ReadinessIssue } from '../domain/readiness.js';
import {
  assessReadiness,
  describeApproval,
  summarizeOutcomes,
} from '../domain/readiness.js';
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
  /** Records the exact version, scope and person who approved it before activation commits. */
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
  /** Reads the workspace approval setting so approval is described as admission applies it. */
  approvalPolicy: Pick<PolicyService, 'approvalRequirement'>;
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

const runState = (run: PlaybookRunView) =>
  run.execution === 'not_executed'
    ? 'not_executed'
    : run.verification === 'verified'
      ? 'verified'
      : run.verification === 'failed'
        ? 'failed_verification'
        : run.verification === 'inconclusive'
          ? 'inconclusive_verification'
          : run.execution === 'denied'
            ? 'denied'
            : run.execution === 'awaiting_approval'
              ? 'awaiting_decision'
              : 'running';

const runSummary = (state: string | undefined) =>
  state === 'not_executed'
    ? 'Not executed: observe-only.'
    : state === 'verified'
      ? 'The order’s shipping method was independently verified.'
      : state === 'failed_verification'
        ? 'The expected shipping method wasn’t observed on the order.'
        : state === 'inconclusive_verification'
          ? 'The correction couldn’t be confirmed.'
          : state === 'denied'
            ? 'The proposed correction was rejected or wasn’t allowed.'
            : state === 'awaiting_decision'
              ? 'The proposed correction is waiting for approval.'
              : 'The correction is in progress.';

/**
 * Derives readiness from current connection access and active grants. An active grant on a
 * connection that lost access blocks that scope; it never counts as ready.
 */
function playbookReadiness(input: {
  versionBlockers: string[];
  connections: PlaybookDetail['connections'];
  activations: PlaybookActivationView[];
  runs: PlaybookRunView[];
  approval: PlaybookDetail['summary']['readiness']['approval'];
}) {
  const active = input.activations.filter((a) => a.active);
  const issues: ReadinessIssue[] = input.versionBlockers.map((message) => ({
    code: 'version_unsupported',
    severity: 'blocking',
    message,
    scope: null,
    repair: null,
  }));
  const covered = new Set(active.flatMap((a) => a.grants.targetIds));
  const ready = new Set<string>();
  const granted = [...new Set(active.flatMap((a) => a.grants.connectionIds))];
  const broken = granted.filter((id) => {
    const connection = input.connections.find((c) => c.id === id);

    return !connection || connection.blockers.length > 0;
  });
  for (const activation of active)
    for (const id of activation.grants.connectionIds) {
      const connection = input.connections.find((c) => c.id === id);
      if (!connection || connection.blockers.length) continue;
      for (const target of activation.grants.targetIds)
        if (connection.targets.some((t) => t.id === target)) ready.add(target);
    }
  for (const id of broken) {
    const connection = input.connections.find((c) => c.id === id);
    issues.push({
      code: connection ? 'connection_access' : 'connection_removed',
      severity: broken.length === granted.length ? 'blocking' : 'degrading',
      message: connection
        ? connection.blockers.join(' ')
        : 'The granted connection was removed. Revoke this activation and review a new scope.',
      scope: connection?.label ?? null,
      repair: {
        label: 'Repair access in Connections',
        destination: 'connections',
        recordId: id,
      },
    });
  }
  const unmapped = [...covered].filter((id) => !ready.has(id)).length;
  if (!broken.length && unmapped)
    issues.push({
      code: 'targets_unmapped',
      severity: unmapped === covered.size ? 'blocking' : 'degrading',
      message: `${unmapped} granted ${unmapped === 1 ? 'order is' : 'orders are'} no longer mapped on the connection, so Luma won’t change ${unmapped === 1 ? 'it' : 'them'}.`,
      scope: null,
      repair: { label: 'Check order mappings', destination: 'connections' },
    });
  const eligible = input.connections.find((c) => !c.blockers.length);
  if (!active.length && !eligible) {
    const [first] = input.connections;
    issues.push({
      code: 'no_connection',
      severity: 'blocking',
      message: first
        ? first.blockers.join(' ')
        : 'No connection is installed. Connect the shop or ERP that holds the orders.',
      scope: first?.label ?? null,
      repair: {
        label: first ? 'Repair access in Connections' : 'Connect a source',
        destination: 'connections',
        ...(first ? { recordId: first.id } : {}),
      },
    });
  }
  const states = input.runs.map((run) => ({
    id: run.id,
    createdAt: run.createdAt,
    state: runState(run),
  }));

  return assessReadiness({
    enablement: active.length
      ? 'enabled'
      : input.activations.length
        ? 'paused'
        : 'not_enabled',
    issues,
    coverage: {
      unit: 'order',
      covered: covered.size,
      ready: ready.size,
      explanation: covered.size
        ? `${covered.size} ${covered.size === 1 ? 'order is' : 'orders are'} granted. ${ready.size} can be corrected with current access.`
        : 'No order is granted yet. An activation names the exact orders Luma may correct.',
    },
    approval: input.approval,
    // Needs you owns case decisions; a run's last outcome can outlive an expired approval.
    waiting: {
      count: null,
      repair: { label: 'Open Needs you', destination: 'needs_you' },
    },
    outcomes: summarizeOutcomes(states, runSummary),
    enable: {
      label: input.activations.length
        ? 'Review a new activation'
        : 'Review activation',
      destination: 'workflow_rules',
    },
    idle: `Luma can correct the shipping method on ${covered.size} granted ${covered.size === 1 ? 'order' : 'orders'} when the issue is detected.`,
  });
}

/** Provides member-readable playbooks and atomic activation commands for people who can activate playbooks. */
export function createPlaybookLibrary(deps: PlaybookLibraryDependencies) {
  async function authorize(context: TenantContext, permission: Permission) {
    const fresh = await deps.refreshContext(context);
    requireTenant(fresh, context.tenantId);
    requirePermission(fresh, permission);
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
    const [published, activations, sources, runs] = await Promise.all([
      scope.store.versions(context, definitionId),
      scope.store.activations(context, definitionId),
      scope.grants(context, lock),
      lock ? [] : scope.store.runs(context, definitionId),
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
    const action = published[0]!.ir.action;
    const requirement = await deps.approvalPolicy.approvalRequirement(
      context.tenantId,
      {
        minimumRisk: action.minimumRisk,
        workflowRequired: published[0]!.ir.approval.mode === 'required',
      },
    );
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
      readiness: playbookReadiness({
        versionBlockers: latest.blockers,
        connections,
        activations,
        runs,
        approval: describeApproval(requirement, 'shipping-method correction'),
      }),
    };

    return {
      summary,
      versions,
      connections,
      activations,
      policyVersion: currentPolicyVersion,
      principalId: context.actor.id,
      canManage: hasPermission(context, 'playbooks.activate'),
      evaluationEvidence: 'unavailable',
    };
  }

  return {
    async list(context: TenantContext) {
      context = await authorize(context, 'workflows.read');
      const versions = await deps.store.versions(context);
      const ids = [...new Set(versions.map((v) => v.definition.id))];

      return Promise.all(
        ids.map(async (id) => (await detail(context, id, deps)).summary),
      );
    },
    async detail(context: TenantContext, id: string) {
      return detail(await authorize(context, 'workflows.read'), id, deps);
    },
    async runs(context: TenantContext, id: string) {
      context = await authorize(context, 'workflows.read');
      if (!(await deps.store.versions(context, id)).length) return missing();

      return deps.store.runs(context, id);
    },
    async activate(
      context: TenantContext,
      id: string,
      request: ActivatePlaybook,
    ) {
      context = await authorize(context, 'playbooks.activate');

      return deps.transaction(context, async (scope) => {
        context = await authorize(context, 'playbooks.activate');
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
      context = await authorize(context, 'playbooks.activate');

      return deps.transaction(context, async (scope) => {
        context = await authorize(context, 'playbooks.activate');
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
