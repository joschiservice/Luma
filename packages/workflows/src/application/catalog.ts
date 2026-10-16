import type { ActionDiff } from '@luma/connections';
import type { Permission, TenantContext } from '@luma/identity';
import {
  hasPermission,
  IdentityError,
  requirePermission,
  requireTenant,
} from '@luma/identity';
import type { PolicyService } from '@luma/policies';

import type { EvaluateCode } from '../domain/code-evaluation.js';
import type { PlaybookVersion } from '../domain/playbook.js';
import type { PlaybookSummary } from '../domain/playbook-library.js';
import { presentPlaybook } from '../domain/playbook-presentation.js';
import type { ProcessStepOutput } from '../domain/process.js';
import { presentProcessVersion } from '../domain/process-presentation.js';
import {
  type ApprovalBehavior,
  assessReadiness,
  describeApproval,
  summarizeOutcomes,
} from '../domain/readiness.js';
import type {
  PublishedWorkflowVersion,
  WorkflowTriggerRequest,
  WorkflowTriggerRun,
} from '../domain/workflow.js';
import { resolutionWorkflow } from '../domain/workflow.js';
import type { CaseWorkflows } from './case-workflows.js';
import type { createCodeEvaluations } from './code-evaluations.js';
import type { createWorkflowCoordination } from './coordination.js';
import type { PlaybookOutcome, PlaybookRun } from './playbook.js';
import type { PlaybookLibrary } from './playbook-library.js';
import type {
  ReplenishmentPositionQuery,
  ReplenishmentWorkflow,
} from './replenishment-port.js';
import {
  presentResolutionRun,
  presentResolutionStory,
  resolutionWorkflowRun,
} from './run-presentation.js';
import { presentTriggerRun } from './trigger-presentation.js';
import type { createWorkflowTriggers } from './triggers.js';

export interface WorkflowCatalogStore {
  cancelCode?(
    context: TenantContext,
    definitionId: string,
    runId: string,
    stepId: string,
  ): Promise<void>;
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

/**
 * A person named by a recorded user ID, as Activity names them.
 *
 * @public Declaration emit names it in the inferred type of `createWorkflows`.
 */
export interface WorkflowPerson {
  kind:
    'member' | 'former_member' | 'luma' | 'support' | 'service' | 'unrecorded';
  id: string | null;
  name: string | null;
  email: string | null;
  workflow: { id: string; name: string | null } | null;
}

/**
 * Names the people behind recorded user IDs in one read. Values that are not user IDs are
 * skipped, because they are names already.
 */
export type WorkflowPeople = (
  context: TenantContext,
  ids: readonly (string | null)[],
) => Promise<WorkflowPerson[]>;

/** Combines native definitions and existing resolution definitions under one authorized catalog. */
export function createWorkflowCatalog(deps: {
  /** Reads the current waiting immutable action reviews; omitted while the release is off. */
  actionReviews?: (
    context: TenantContext,
    requests: { id: string; proposalId: string }[],
  ) => Promise<Map<string, ActionDiff | null>>;
  coordination?: ReturnType<typeof createWorkflowCoordination>;
  codeProcesses?: {
    supported(version: PublishedWorkflowVersion): boolean;
    start(context: TenantContext, run: WorkflowTriggerRun): Promise<void>;
  };
  codeEvaluations?: ReturnType<typeof createCodeEvaluations>;
  replenishment?: ReplenishmentWorkflow;
  /** Built-in workflows that start for new cases. */
  caseWorkflows?: CaseWorkflows;
  legacy: PlaybookLibrary;
  triggers: ReturnType<typeof createWorkflowTriggers>;
  store: WorkflowCatalogStore;
  compile(input: unknown): PublishedWorkflowVersion;
  refreshContext(context: TenantContext): Promise<TenantContext>;
  /** Reads the workspace approval setting for versions with actions. */
  approvalPolicy: Pick<PolicyService, 'approvalRequirement'>;
  /** Without it, responses list nobody. */
  people?: WorkflowPeople;
  /** Explains why no installed adapter can run a version. */
  explain?(
    context: TenantContext,
    version: PublishedWorkflowVersion,
  ): Promise<string[]>;
}) {
  async function authorize(context: TenantContext, permission: Permission) {
    const fresh = await deps.refreshContext(context);
    requireTenant(fresh, context.tenantId);
    requirePermission(fresh, permission);
    if (fresh.actor.id !== context.actor.id)
      throw new IdentityError(403, 'FORBIDDEN', 'Sign in again to continue.');

    return fresh;
  }

  /** Resolution playbooks fix detected issues, so each starts when its issue type is detected. */
  const legacySummary = (summary: PlaybookSummary) => ({
    ...summary,
    category: 'resolution',
    trigger: { kind: 'exception' as const, issueType: summary.issueType },
  });
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
  const computationBlocker =
    'No installed adapter runs this workflow. Custom workflows run when they contain a Code Step and only computation steps.';

  /** Lists why each version cannot run, keyed by version. Runnable versions have no reasons. */
  async function explain(
    context: TenantContext,
    versions: PublishedWorkflowVersion[],
  ) {
    const reasons = new Map<string, string[]>();
    for (const version of versions) {
      if (deps.codeProcesses?.supported(version)) {
        reasons.set(version.version, []);
        continue;
      }
      const explained =
        version.format === 'workflow/2'
          ? ((await deps.explain?.(context, version)) ?? [])
          : [];
      reasons.set(
        version.version,
        explained.length
          ? explained
          : [
              version.format === 'workflow/2'
                ? computationBlocker
                : nativeBlocker,
            ],
      );
    }

    return reasons;
  }

  function nativeDetail(
    versions: PublishedWorkflowVersion[],
    context: TenantContext,
    reasons: Map<string, string[]>,
  ) {
    versions.sort((a, b) =>
      b.version.localeCompare(a.version, undefined, { numeric: true }),
    );
    const current = versions[0]!;
    const codeAvailable = deps.codeProcesses?.supported(current) ?? false;
    const currentBlockers = reasons.get(current.version) ?? [nativeBlocker];
    const views = versions.map((v) => {
      if (v.format === 'workflow/2')
        return {
          ...presentProcessVersion(v),
          ...metadata(v),
          format: 'workflow/2' as const,
          ...(deps.codeProcesses?.supported(v)
            ? {
                executionMode: 'computation' as const,
                compatible: true,
                blockers: [],
              }
            : { blockers: reasons.get(v.version) ?? [computationBlocker] }),
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
        trigger: current.applicability.trigger,
        capability: views[0]!.capability,
        issueType: current.context.kind,
        systems: [] as string[],
        availableVersion: current.version,
        status: codeAvailable
          ? ('inactive' as const)
          : ('unavailable' as const),
        blockers: codeAvailable ? [] : currentBlockers,
        activeVersions: [] as string[],
      },
      versions: views,
      connections: [],
      activations: [],
      policyVersion: '',
      principalId: context.actor.id,
      // Starting and cancelling runs is the primary write on a native workflow's detail.
      canManage: hasPermission(context, 'workflows.triggers.manage'),
      evaluationEvidence: 'unavailable' as const,
    };
  }

  /** States who approves a native version's actions under current policy. */
  async function nativeApproval(
    context: TenantContext,
    version: PublishedWorkflowVersion,
  ): Promise<ApprovalBehavior> {
    if (version.format !== 'workflow/2') {
      const requirement = await deps.approvalPolicy.approvalRequirement(
        context.tenantId,
        {
          minimumRisk: version.policy.minimumRisk,
          workflowRequired: version.policy.approval === 'required',
        },
      );

      return describeApproval(requirement, 'action');
    }
    const actions = version.steps.filter((step) => step.kind === 'capability');
    const granted = version.steps.some(
      (step) => step.kind === 'code' && step.grants.length > 0,
    );
    if (!actions.length && !granted)
      return {
        mode: 'no_actions',
        summary:
          'This workflow doesn’t change connected systems, so nothing needs approval.',
        details: [
          'It computes values from the evidence supplied when it starts.',
        ],
      };
    const requirement = await deps.approvalPolicy.approvalRequirement(
      context.tenantId,
      {
        minimumRisk: actions.some((step) => step.minimumRisk !== 'low')
          ? 'medium'
          : 'low',
        workflowRequired: version.steps.some(
          (step) => step.kind === 'approval',
        ),
      },
    );

    return describeApproval(requirement, 'action');
  }

  /** Adds readiness to a native detail from its blockers and triggered runs. */
  async function withReadiness(
    context: TenantContext,
    versions: PublishedWorkflowVersion[],
    reasons: Map<string, string[]>,
  ) {
    const detail = nativeDetail(versions, context, reasons);
    const current = versions[0]!;
    const runnable = deps.codeProcesses?.supported(current) ?? false;
    const starts = await deps.triggers.list(context, current.definition.id);
    const evidence = await deps.store.processSteps(
      context,
      starts.map((run) => run.id),
    );
    const outcomes = summarizeOutcomes(
      starts.map((run) => ({
        id: run.id,
        createdAt: run.createdAt,
        state: presentTriggerRun(run, evidence.get(run.id)).processState,
      })),
      (state) =>
        state === 'verified'
          ? 'The expected result was verified.'
          : state === 'ended'
            ? 'The run finished without acting.'
            : state
              ? `The run is ${state.replaceAll('_', ' ')}.`
              : 'The run is waiting to start.',
    );

    return {
      ...detail,
      summary: {
        ...detail.summary,
        readiness: assessReadiness({
          enablement: runnable ? 'enabled' : 'not_enabled',
          issues: detail.summary.blockers.map((message) => ({
            code: 'no_adapter',
            severity: 'blocking' as const,
            message,
            scope: null,
            repair: null,
          })),
          coverage: {
            unit: 'run',
            covered: null,
            ready: null,
            explanation:
              'This workflow has no scoped records. It runs on the evidence supplied when someone starts it.',
          },
          approval: await nativeApproval(context, current),
          waiting: { count: null, repair: null },
          outcomes,
          enable: runnable
            ? { label: 'Start a run', destination: 'workflow_rules' }
            : null,
          idle: 'People who can manage workflow triggers start this workflow from its rules with the evidence it needs.',
        }),
      },
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

  /** Reads a workflow from the definition's owner. */
  async function view(context: TenantContext, id: string) {
    if (id === deps.replenishment?.definitionId)
      return deps.replenishment.detail(context);
    if (deps.caseWorkflows?.owns(id))
      return deps.caseWorkflows.detail(context, id);
    const native = await deps.store.versions(context, id);
    if (native.length)
      return withReadiness(context, native, await explain(context, native));
    const detail = await deps.legacy.detail(context, id);
    // Versions are append-only; read after the view to include any concurrently published version.
    const versions = await deps.store.resolutionVersions(context, id);

    return {
      ...detail,
      summary: legacySummary(detail.summary),
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
  }

  /** Reads up to 50 recent runs, newest first. */
  async function runs(context: TenantContext, id: string) {
    const starts = await deps.triggers.list(context, id);
    const evidence = await deps.store.processSteps(
      context,
      starts.map((run) => run.id),
    );
    const pending = starts.flatMap((run) => {
      const step = [...(evidence.get(run.id) ?? [])]
        .reverse()
        .find(
          (output) =>
            output.kind === 'capability' &&
            output.state === 'waiting' &&
            typeof output.values.proposalId === 'string',
        );

      return step && typeof step.values.proposalId === 'string'
        ? [
            {
              id: run.id,
              stepId: step.stepId,
              proposalId: step.values.proposalId,
            },
          ]
        : [];
    });
    const reviews = await deps.actionReviews?.(context, pending);
    const triggered = starts.map((run) => ({
      ...presentTriggerRun(run, evidence.get(run.id)),
      ...(reviews?.get(run.id)
        ? {
            actionReviews: [
              {
                stepId: pending.find((item) => item.id === run.id)!.stepId,
                diff: reviews.get(run.id)!,
              },
            ],
          }
        : {}),
    }));
    if (
      id === deps.replenishment?.definitionId ||
      deps.caseWorkflows?.owns(id) ||
      (await deps.store.versions(context, id)).length
    )
      return triggered;
    if (!(await deps.store.resolutionVersions(context, id)).length)
      throw new IdentityError(404, 'NOT_FOUND', 'Workflow not found');
    const records = await deps.store.runs(context, id);

    const resolution = records.map(({ run, version, outcomes }) => {
      const projection = resolutionWorkflowRun(run, version);
      const presented = presentResolutionRun(run, version, outcomes.at(-1));

      return {
        ...presented,
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
  }

  const people = async (context: TenantContext, ids: (string | null)[]) =>
    deps.people ? deps.people(context, ids) : [];

  return {
    coordination: deps.coordination,
    subscriptions: deps.triggers.subscriptions,
    configureSubscription: deps.triggers.configureSubscription,
    /** Runs a fixture evaluation without access to production capabilities. */
    async evaluateCode(
      context: TenantContext,
      id: string,
      request: EvaluateCode,
    ) {
      if (!deps.codeEvaluations)
        throw new IdentityError(
          503,
          'SERVICE_UNAVAILABLE',
          'Code evaluation is unavailable on this Luma server. Whoever runs the server needs to install the Code Step runtime.',
        );

      return deps.codeEvaluations.start(context, id, request);
    },
    /** Reads a private evaluation and its resource diagnostics. */
    async codeEvaluation(
      context: TenantContext,
      id: string,
      evaluationId: string,
    ) {
      if (!deps.codeEvaluations)
        throw new IdentityError(
          503,
          'SERVICE_UNAVAILABLE',
          'Code evaluation is unavailable.',
        );

      return deps.codeEvaluations.get(context, id, evaluationId);
    },
    /** Cancels a fixture evaluation across API instances. */
    async cancelCodeEvaluation(
      context: TenantContext,
      id: string,
      evaluationId: string,
    ) {
      if (!deps.codeEvaluations)
        throw new IdentityError(
          503,
          'SERVICE_UNAVAILABLE',
          'Code evaluation is unavailable.',
        );

      return deps.codeEvaluations.cancel(context, id, evaluationId);
    },
    /** Stops a sandbox and blocks subsequent capability requests without undoing admitted actions. */
    async cancelCodeStep(
      context: TenantContext,
      id: string,
      runId: string,
      stepId: string,
    ) {
      context = await authorize(context, 'workflows.triggers.manage');
      if (!deps.store.cancelCode)
        throw new IdentityError(
          503,
          'SERVICE_UNAVAILABLE',
          'Code execution is unavailable.',
        );
      await deps.store.cancelCode(context, id, runId, stepId);

      return { cancelled: true as const };
    },
    /** Reads available stock and replenishment rules. */
    replenishmentSetup: (
      context: TenantContext,
      id: string,
      query: ReplenishmentPositionQuery,
    ) => replenishment(id).setup(context, query),
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
    /**
     * Lists the workflows that can cover one record, with readiness scoped to it. Only stock
     * positions have a covering workflow today; other kinds return an empty list.
     */
    async coverage(
      context: TenantContext,
      subject: { kind: 'inventory_position'; id: string },
    ) {
      context = await authorize(context, 'workflows.read');
      if (subject.kind !== 'inventory_position' || !deps.replenishment)
        return [];

      return [await deps.replenishment.coverage(context, subject.id)];
    },
    /** Activates several replenishment rules, reporting each result. */
    configureReplenishmentMany: (
      context: TenantContext,
      id: string,
      items: Parameters<ReplenishmentWorkflow['configureMany']>[1],
    ) => replenishment(id).configureMany(context, items),
    /** Checks proposed replenishment rules without changing anything. */
    previewReplenishment: (
      context: TenantContext,
      id: string,
      input: Parameters<ReplenishmentWorkflow['preview']>[1],
    ) => replenishment(id).preview(context, input),
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
      if (deps.caseWorkflows?.owns(id))
        throw new IdentityError(
          409,
          'CONFLICT',
          'This workflow starts from detected cases. Turn it on instead of starting it by hand.',
        );

      const run = await deps.triggers.fire(context, id, request);
      await deps.codeProcesses?.start(context, run);

      return presentTriggerRun(run);
    },
    /** Cancels a scheduled start while it is still pending. */
    async cancelStart(context: TenantContext, id: string, runId: string) {
      return presentTriggerRun(await deps.triggers.cancel(context, id, runId));
    },
    /** Publishes a validated native definition; publication never grants execution authority. */
    async publish(context: TenantContext, input: unknown) {
      context = await authorize(context, 'workflows.publish');
      const version = deps.compile(input);
      await deps.store.publish(context, version);

      return version;
    },
    async list(context: TenantContext) {
      context = await authorize(context, 'workflows.read');
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

      const [replenishmentDetail, caseSummaries] = await Promise.all([
        deps.replenishment?.detail(context),
        deps.caseWorkflows?.summaries(context) ?? [],
      ]);

      return [
        ...(replenishmentDetail ? [replenishmentDetail.summary] : []),
        ...caseSummaries,
        ...legacy.map(legacySummary),
        ...(await Promise.all(
          [...groups.values()]
            .filter(
              (v) =>
                v[0]!.definition.id !== deps.replenishment?.definitionId &&
                !deps.caseWorkflows?.owns(v[0]!.definition.id),
            )
            .map(
              async (v) =>
                (await withReadiness(context, v, await explain(context, v)))
                  .summary,
            ),
        )),
      ];
    },
    /** Reads a workflow with the people its activations, reviews and versions name. */
    async detail(context: TenantContext, id: string) {
      context = await authorize(context, 'workflows.read');
      const detail = await view(context, id);

      return {
        ...detail,
        people: await people(context, [
          detail.principalId,
          ...detail.activations.flatMap((a) => [
            ...a.grants.principalIds,
            a.reviewedBy,
          ]),
          ...detail.versions.map((v) => v.provenance.authoredBy),
        ]),
      };
    },
    async runs(context: TenantContext, id: string) {
      context = await authorize(context, 'workflows.read');
      const items = await runs(context, id);

      return {
        items,
        people: await people(
          context,
          items.map((run) =>
            run.actor.kind === 'agent' ? run.actor.operatorId : run.actor.id,
          ),
        ),
      };
    },
    async activate(...args: Parameters<PlaybookLibrary['activate']>) {
      const [context, id, request] = args;
      const fresh = await authorize(context, 'playbooks.activate');
      if (deps.caseWorkflows?.owns(id))
        throw new IdentityError(
          409,
          'CONFLICT',
          'Turn this workflow on for the workspace instead of choosing orders.',
        );
      if ((await deps.store.versions(fresh, id)).length)
        throw new IdentityError(409, 'CONFLICT', nativeBlocker);

      return deps.legacy.activate(fresh, id, request);
    },
    /** Turns a case workflow on for the workspace as the caller, after reviewing its version and policy. */
    activateCase(
      context: TenantContext,
      id: string,
      input: Parameters<CaseWorkflows['activate']>[2],
    ) {
      if (!deps.caseWorkflows?.owns(id))
        throw new IdentityError(404, 'NOT_FOUND', 'Workflow not found.');

      return deps.caseWorkflows.activate(context, id, input);
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
        : deps.caseWorkflows?.owns(id)
          ? deps.caseWorkflows.revoke(context, id, activationId, digest)
          : deps.legacy.revoke(context, id, activationId, digest),
  };
}

export type WorkflowCatalog = ReturnType<typeof createWorkflowCatalog>;
