import type { TenantContext } from '@luma/identity';
import { IdentityError, requireRole, requireTenant } from '@luma/identity';

import type { PlaybookVersion } from '../domain/playbook.js';
import { presentPlaybook } from '../domain/playbook-presentation.js';
import type { ProcessStepOutput } from '../domain/process.js';
import { presentProcessVersion } from '../domain/process-presentation.js';
import type {
  PublishedWorkflowVersion,
  WorkflowTriggerRequest,
} from '../domain/workflow.js';
import { resolutionWorkflow } from '../domain/workflow.js';
import type { PlaybookOutcome, PlaybookRun } from './playbook.js';
import type { PlaybookLibrary } from './playbook-library.js';
import type { ReplenishmentWorkflow } from './replenishment-port.js';
import {
  presentResolutionRun,
  presentResolutionStory,
  resolutionWorkflowRun,
} from './run-presentation.js';
import { presentTriggerRun } from './trigger-presentation.js';
import type { createWorkflowTriggers } from './triggers.js';

export interface WorkflowCatalogStore {
  /** Reads native immutable contracts. Resolution adapters retain their original records. */
  versions(
    context: TenantContext,
    id?: string,
  ): Promise<PublishedWorkflowVersion[]>;
  /** Persists an exact native version; conflicting definitions or versions fail. */
  publish(
    context: TenantContext,
    version: PublishedWorkflowVersion,
  ): Promise<void>;
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
  processSteps(
    context: TenantContext,
    runIds: string[],
  ): Promise<Map<string, ProcessStepOutput[]>>;
}

/** Combines native definitions and existing resolution definitions under one authorized catalog. */
export function createWorkflowCatalog(deps: {
  replenishment?: ReplenishmentWorkflow;
  legacy: PlaybookLibrary;
  triggers: ReturnType<typeof createWorkflowTriggers>;
  store: WorkflowCatalogStore;
  compile(input: unknown): PublishedWorkflowVersion;
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

  const metadata = (version: PublishedWorkflowVersion) => ({
    category: version.definition.category,
    applicability: version.applicability,
    inputs: version.inputs,
    context: version.context,
    ...(version.format === 'workflow/1'
      ? { policy: version.policy, outcome: version.outcome }
      : {}),
    format: version.format,
  });
  const nativeBlocker =
    'Runs can collect trigger evidence. Action execution is not available for this workflow.';

  function nativeDetail(
    versions: PublishedWorkflowVersion[],
    context: TenantContext,
  ) {
    versions.sort((a, b) =>
      b.version.localeCompare(a.version, undefined, { numeric: true }),
    );
    const current = versions[0]!;
    const views = versions.map((v) => {
      if (v.format === 'workflow/2')
        return {
          ...presentProcessVersion(v),
          ...metadata(v),
          format: 'workflow/2' as const,
        };
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
        policy: v.policy,
        outcome: v.outcome,
        format: v.format,
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

  function replenishment(id: string) {
    if (!deps.replenishment || id !== deps.replenishment.definitionId)
      throw new IdentityError(
        404,
        'NOT_FOUND',
        'Replenishment workflow not found.',
      );

    return deps.replenishment;
  }

  return {
    /** Reads available stock and replenishment rules. */
    replenishmentSetup: (context: TenantContext, id: string) =>
      replenishment(id).setup(context),
    /** Activates an exact replenishment scope. */
    configureReplenishment: (
      context: TenantContext,
      id: string,
      input: Parameters<ReplenishmentWorkflow['configure']>[1],
    ) => replenishment(id).configure(context, input),
    /** Checks authoritative stock before starting the configured process. */
    startReplenishment: (
      context: TenantContext,
      id: string,
      input: Parameters<ReplenishmentWorkflow['start']>[1],
    ) => replenishment(id).start(context, input),
    /** Reads the current policy proposal for a run. */
    replenishmentReview: (context: TenantContext, id: string, runId: string) =>
      replenishment(id).review(context, runId),
    /** Persists an independent human decision for the bound proposal. */
    decideReplenishment: (
      context: TenantContext,
      id: string,
      runId: string,
      input: Parameters<ReplenishmentWorkflow['decide']>[2],
    ) => replenishment(id).decide(context, runId, input),
    /** Starts a run using the exact version and supplied signal evidence. */
    async fire(
      context: TenantContext,
      id: string,
      request: WorkflowTriggerRequest,
    ) {
      if (id === deps.replenishment?.definitionId)
        throw new IdentityError(
          409,
          'CONFLICT',
          'Use the replenishment stock check to start this workflow.',
        );

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
      const groups = new Map<string, PublishedWorkflowVersion[]>();
      for (const v of native)
        groups.set(v.definition.id, [
          ...(groups.get(v.definition.id) ?? []),
          v,
        ]);

      const replenishmentDetail = await deps.replenishment?.detail(context);

      return [
        ...(replenishmentDetail ? [replenishmentDetail.summary] : []),
        ...legacy.map((v) => ({ ...v, category: 'resolution' })),
        ...[...groups.values()]
          .filter(
            (v) => v[0]!.definition.id !== deps.replenishment?.definitionId,
          )
          .map((v) => nativeDetail(v, context).summary),
      ];
    },
    async detail(context: TenantContext, id: string) {
      context = await authorize(context);
      if (id === deps.replenishment?.definitionId)
        return deps.replenishment.detail(context);
      const native = await deps.store.versions(context, id);
      if (native.length) return nativeDetail(native, context);
      const detail = await deps.legacy.detail(context, id);
      // Versions are append-only; read after the view to include any concurrently published version.
      const versions = await deps.store.resolutionVersions(context, id);

      return {
        ...detail,
        summary: { ...detail.summary, category: 'resolution' },
        versions: detail.versions.map((v) => {
          const source = versions.find((item) => item.version === v.version);
          if (!source) throw new Error('Published version is unavailable');
          const workflow = resolutionWorkflow(source);

          return {
            ...v,
            ...metadata(workflow),
            policy: workflow.policy,
            outcome: workflow.outcome,
            format: 'resolution-playbook/0' as const,
          };
        }),
      };
    },
    async runs(context: TenantContext, id: string) {
      context = await authorize(context);
      const starts = await deps.triggers.list(context, id);
      const evidence = await deps.store.processSteps(
        context,
        starts.map((run) => run.id),
      );
      const triggered = starts.map((run) =>
        presentTriggerRun(run, evidence.get(run.id)),
      );
      if (
        id === deps.replenishment?.definitionId ||
        (await deps.store.versions(context, id)).length
      )
        return triggered;
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
    /** Revokes the exact reviewed activation. */
    revoke: (
      context: TenantContext,
      id: string,
      activationId: string,
      digest: string,
    ) =>
      id === deps.replenishment?.definitionId
        ? deps.replenishment.revoke(context, activationId, digest)
        : deps.legacy.revoke(context, id, activationId, digest),
  };
}

export type WorkflowCatalog = ReturnType<typeof createWorkflowCatalog>;
