import type { TenantContext } from '@luma/identity';
import { IdentityError, requireRole, requireTenant } from '@luma/identity';

import type { PlaybookVersion } from '../domain/playbook.js';
import { presentPlaybook } from '../domain/playbook-presentation.js';
import type {
  WorkflowTriggerRequest,
  WorkflowVersion,
} from '../domain/workflow.js';
import { resolutionWorkflow } from '../domain/workflow.js';
import type { PlaybookOutcome, PlaybookRun } from './playbook.js';
import type { PlaybookLibrary } from './playbook-library.js';
import {
  presentResolutionRun,
  presentResolutionStory,
  resolutionWorkflowRun,
} from './run-presentation.js';
import { presentTriggerRun } from './trigger-presentation.js';
import type { createWorkflowTriggers } from './triggers.js';

export interface WorkflowCatalogStore {
  /** Reads native immutable contracts. Resolution adapters retain their original records. */
  versions(context: TenantContext, id?: string): Promise<WorkflowVersion[]>;
  /** Persists an exact native version; conflicting definitions or versions fail. */
  publish(context: TenantContext, version: WorkflowVersion): Promise<void>;
  /** Reads validated resolution versions for projection into the common contract. */
  resolutionVersions(
    context: TenantContext,
    id: string,
  ): Promise<PlaybookVersion[]>;
  /** Reads recent runs and their append-only step evidence from the owner store. */
  runs(
    context: TenantContext,
    id: string,
  ): Promise<
    {
      run: PlaybookRun;
      version: PlaybookVersion;
      outcomes: PlaybookOutcome[];
    }[]
  >;
}

/** Combines native definitions and existing resolution definitions under one authorized catalog. */
export function createWorkflowCatalog(deps: {
  legacy: PlaybookLibrary;
  triggers: ReturnType<typeof createWorkflowTriggers>;
  store: WorkflowCatalogStore;
  compile(input: unknown): WorkflowVersion;
  refreshContext(context: TenantContext): Promise<TenantContext>;
}) {
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

  const metadata = (version: WorkflowVersion) => ({
    category: version.definition.category,
    applicability: version.applicability,
    inputs: version.inputs,
    context: version.context,
    policy: version.policy,
    outcome: version.outcome,
    format: version.format,
  });
  const nativeBlocker =
    'Runs can collect trigger evidence. Action execution is not available for this workflow.';

  function nativeDetail(versions: WorkflowVersion[], context: TenantContext) {
    versions.sort((a, b) =>
      b.version.localeCompare(a.version, undefined, { numeric: true }),
    );
    const current = versions[0]!;
    const views = versions.map((v) => {
      const [eligibility, action, approval, verification, recovery] = v.steps;
      const presentation = presentPlaybook({
        definition: v.definition,
        version: v.version,
        digest: v.digest,
        compatibility: { interpreter: 'resolution-playbook/0', admission: 1 },
        provenance: v.provenance,
        ir: {
          schemaVersion: 1,
          inputs: v.inputs,
          evidence: v.context,
          eligibility,
          action,
          approval,
          verification,
          recovery,
        },
      });

      return {
        ...presentation,
        ...metadata(v),
        compatible: false,
        blockers: [nativeBlocker],
        representation: JSON.stringify(v, null, 2),
      };
    });

    return {
      summary: {
        id: current.definition.id,
        name: current.definition.name,
        purpose: current.definition.intent,
        category: current.definition.category,
        capability: views[0]!.capability,
        issueType: current.context.kind,
        systems: [] as string[],
        availableVersion: current.version,
        status: 'unavailable' as const,
        blockers: [nativeBlocker],
        activeVersions: [] as string[],
      },
      versions: views,
      connections: [],
      activations: [],
      policyVersion: '',
      principalId: context.actor.id,
      canManage: context.actor.role !== 'member',
      evaluationEvidence: 'unavailable' as const,
    };
  }

  return {
    /** Starts a run using the exact version and supplied signal evidence. */
    async fire(
      context: TenantContext,
      id: string,
      request: WorkflowTriggerRequest,
    ) {
      return presentTriggerRun(await deps.triggers.fire(context, id, request));
    },
    /** Cancels a scheduled start while it is still pending. */
    async cancelStart(context: TenantContext, id: string, runId: string) {
      return presentTriggerRun(await deps.triggers.cancel(context, id, runId));
    },
    /** Publishes a validated native definition; publication never grants execution authority. */
    async publish(context: TenantContext, input: unknown) {
      context = await authorize(context, true);
      const version = deps.compile(input);
      await deps.store.publish(context, version);

      return version;
    },
    async list(context: TenantContext) {
      context = await authorize(context);
      const [legacy, native] = await Promise.all([
        deps.legacy.list(context),
        deps.store.versions(context),
      ]);
      const groups = new Map<string, WorkflowVersion[]>();
      for (const v of native)
        groups.set(v.definition.id, [
          ...(groups.get(v.definition.id) ?? []),
          v,
        ]);

      return [
        ...legacy.map((v) => ({ ...v, category: 'resolution' })),
        ...[...groups.values()].map((v) => nativeDetail(v, context).summary),
      ];
    },
    async detail(context: TenantContext, id: string) {
      context = await authorize(context);
      const native = await deps.store.versions(context, id);
      if (native.length) return nativeDetail(native, context);
      const detail = await deps.legacy.detail(context, id);
      // Versions are append-only; read after the view to include any concurrently published version.
      const versions = await deps.store.resolutionVersions(context, id);

      return {
        ...detail,
        summary: { ...detail.summary, category: 'resolution' },
        versions: detail.versions.map((v) => ({
          ...v,
          ...metadata(
            resolutionWorkflow(
              versions.find((source) => source.version === v.version)!,
            ),
          ),
        })),
      };
    },
    async runs(context: TenantContext, id: string) {
      context = await authorize(context);
      const triggered = (await deps.triggers.list(context, id)).map(
        presentTriggerRun,
      );
      if ((await deps.store.versions(context, id)).length) return triggered;
      if (!(await deps.store.resolutionVersions(context, id)).length)
        throw new IdentityError(404, 'NOT_FOUND', 'Workflow not found');
      const records = await deps.store.runs(context, id);

      const resolution = records.map(({ run, version, outcomes }) => {
        const projection = resolutionWorkflowRun(run, version);
        const view = presentResolutionRun(run, version, outcomes.at(-1));

        return {
          ...view,
          story: presentResolutionStory(run, version, outcomes.at(-1)),
          trigger: projection.trigger,
          subject: projection.subject,
          actor: projection.actor,
          resolution: projection.resolution,
          contextDigest: projection.contextDigest,
          steps: outcomes.map((o) => ({
            stepId: o.stepId,
            state: o.state,
            reason: o.reason,
            proposalId: o.proposalId,
            decisionId: o.decisionId ?? null,
          })),
        };
      });

      return [...triggered, ...resolution]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 50);
    },
    async activate(...args: Parameters<PlaybookLibrary['activate']>) {
      const [context, id, request] = args;
      const fresh = await authorize(context, true);
      if ((await deps.store.versions(fresh, id)).length)
        throw new IdentityError(409, 'CONFLICT', nativeBlocker);

      return deps.legacy.activate(fresh, id, request);
    },
    revoke: deps.legacy.revoke,
  };
}

export type WorkflowCatalog = ReturnType<typeof createWorkflowCatalog>;
