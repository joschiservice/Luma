import type {
  IdentityService,
  Permission,
  TenantContext,
} from '@luma/identity';
import {
  hasPermission,
  IdentityError,
  requireChangesAllowed,
  requirePermission,
  requireTenant,
} from '@luma/identity';
import { canonicalJson } from '@luma/platform';
import type { PolicyService } from '@luma/policies';

import {
  type CaseActivation,
  type CaseEvidence,
  caseRunOutcome,
  type CaseRunStop,
  type CaseSignal,
  caseStartable,
  type WorkflowSignal,
} from '../domain/case-workflow.js';
import { draftFromVersion } from '../domain/draft.js';
import type {
  ProcessRun,
  ProcessStep,
  ProcessStepOutput,
  ProcessWorkflowVersion,
} from '../domain/process.js';
import { presentProcessVersion } from '../domain/process-presentation.js';
import {
  type ApprovalBehavior,
  assessReadiness,
  describeApproval,
  type ReadinessIssue,
  summarizeOutcomes,
} from '../domain/readiness.js';
import type {
  TemplateRequirement,
  WorkflowTemplate,
} from '../domain/template.js';
import { templateReadiness } from '../domain/template.js';
import type {
  WorkflowTriggerRequest,
  WorkflowTriggerRun,
} from '../domain/workflow.js';
import type { WorkflowCatalogStore } from './catalog.js';
import type { WorkflowAuditEntry } from './drafts.js';
import type {
  ProcessActionResult,
  ProcessActivities,
} from './process-runtime.js';
import type {
  WorkflowActivationView,
  WorkflowDetail,
} from './replenishment-port.js';
import type { TemplateSource } from './templates.js';
import { presentTriggerRun } from './trigger-presentation.js';
import type { WorkflowTriggerStore } from './triggers.js';

type ReadStep = Extract<ProcessStep, { kind: 'read' }>;

type ActionStep = Extract<ProcessStep, { kind: 'capability' }>;

type VerificationStep = Extract<ProcessStep, { kind: 'verification' }>;

/** What an adapter receives for one step of a case run. */
export interface CaseRun {
  run: ProcessRun;
  activation: CaseActivation;
  signal: CaseSignal;
  /** Why no new change may be prepared or sent; existing attempts may still be reconciled. */
  stop: CaseRunStop;
  evidence(): Promise<CaseEvidence[]>;
}

/**
 * A built-in workflow that starts when detection opens a case of its trigger's issue type, or when
 * its owner reports a follow-up through `signals`. The adapter owns its reads, actions and checks,
 * and must send every change through its owner's governed path: persisted proposal, policy
 * approval by a different person, Action Admission and an independent check. Adapters must make
 * every step safe to repeat after a retry or restart.
 */
export interface CaseWorkflowAdapter {
  /**
   * With cases: an `exception` trigger and inputs `activationId` and `caseId`. With signals: an
   * `event` trigger whose type is the context kind, and inputs `activationId` and `signalId`.
   */
  version: ProcessWorkflowVersion;
  /** `unit` names one thing the workflow starts for, such as “return waiting for a refund”. */
  template: {
    trigger: string;
    steps: string[];
    success: string;
    unit?: string;
  };
  /**
   * How approval works, when the workflow's actions only change Luma's own records. Without it,
   * readiness describes the workspace's approval policy for changes in connected systems.
   */
  approval?:
    ApprovalBehavior | ((context: TenantContext) => Promise<ApprovalBehavior>);
  /** The owner's open follow-ups. Without it, the workflow starts from detection cases. */
  signals?: SignalReader;
  /**
   * Where a handed-over run asks a person. `needs_you` adds a Needs you item while the signal is
   * open; `owner` when the owner's own item already asks. Cases always ask through the case.
   */
  handover?: 'needs_you' | 'owner';
  /**
   * `principal` gives the case to the person whose access the run uses when the run hands work to
   * people (a human task or an escalation) and nobody owns the case, so it stays with someone
   * responsible. An existing owner is kept. Cases only.
   */
  caseOwner?: 'principal';
  /** Installed connections this adapter reads or changes; never grants execution scope. */
  connections?(context: TenantContext): Promise<WorkflowDetail['connections']>;
  /** Plain-language titles and descriptions keyed by step ID. */
  stepCopy: Record<string, { title: string; description: string }>;
  /** Workspace prerequisites. Unmet ones block turning the workflow on. */
  requirements(context: TenantContext): Promise<TemplateRequirement[]>;
  /** The record a case run acts on, or null when the case is outside this workflow's reach. */
  subject(
    context: TenantContext,
    signal: CaseSignal,
    evidence: CaseEvidence[],
  ): Promise<{ kind: string; id: string } | null>;
  /** `outputs` are the run's recorded step outputs so far, oldest first. */
  read(
    context: TenantContext,
    run: CaseRun,
    step: ReadStep,
    outputs?: ProcessStepOutput[],
  ): ReturnType<ProcessActivities['read']>;
  action(
    context: TenantContext,
    run: CaseRun,
    step: ActionStep,
    outputs: ProcessStepOutput[],
  ): Promise<ProcessActionResult>;
  verify(
    context: TenantContext,
    run: CaseRun,
    step: VerificationStep,
    outputs: ProcessStepOutput[],
  ): ReturnType<ProcessActivities['verify']>;
}

/** Tenant-isolated case workflow activations. At most one is active per definition. */
export interface CaseActivationStore {
  list(context: TenantContext): Promise<CaseActivation[]>;
  /** Inserts once by ID; returns the stored record. A second active activation fails with 409. */
  insert(
    context: TenantContext,
    activation: CaseActivation,
  ): Promise<CaseActivation>;
  /** Revokes an active activation; returns null when it is unknown. Repeating it is safe. */
  revoke(
    context: TenantContext,
    id: string,
    actorId: string,
    at: string,
  ): Promise<CaseActivation | null>;
}

/** Reads cases through their owner, within the caller's tenant. */
export interface CaseReader {
  open(context: TenantContext): Promise<CaseSignal[]>;
  get(context: TenantContext, id: string): Promise<CaseSignal | null>;
  evidence(context: TenantContext, id: string): Promise<CaseEvidence[]>;
  /**
   * Gives a case nobody owns to `userId` through the case owner's audited assignment; keeps an
   * existing owner. Absent where the host can't assign cases.
   */
  claim?(context: TenantContext, id: string, userId: string): Promise<unknown>;
}

/** An owner's follow-ups for one workflow, within the caller's tenant. */
interface SignalReader {
  open(context: TenantContext): Promise<WorkflowSignal[]>;
  /** The current state of one follow-up; closed when the owner no longer reports it. */
  get(context: TenantContext, id: string): Promise<WorkflowSignal | null>;
}

/** A run that handed its follow-up to a person, while the follow-up is still open. */
export interface WorkflowHandover {
  definitionId: string;
  name: string;
  runId: string;
  handedOverAt: string;
  reason: string | null;
  signal: WorkflowSignal;
}

/** Starts a committed run with a stable Temporal workflow ID. */
export interface CaseRunTransport {
  start(
    context: TenantContext,
    run: ProcessRun,
    version: ProcessWorkflowVersion,
  ): Promise<unknown>;
  /** Idempotent wake only; the process rereads its immutable intent and all current admission controls. */
  notifyDecision?(context: TenantContext, run: ProcessRun): Promise<void>;
}

const openStates = new Set(['running', 'awaiting_decision', 'waiting']);

/** Stands in for requirements Luma couldn't read; it blocks turning the workflow on. */
const unchecked: TemplateRequirement = {
  label: 'Requirements checked',
  met: false,
  detail:
    'Luma couldn’t check what this workflow needs right now. Try again shortly.',
  fix: null,
};

/**
 * Runs built-in workflows on new cases. Each pass records at most one run per case and version,
 * persists it before starting Temporal, and recovers committed starts after a restart.
 */
export function createCaseWorkflows(deps: {
  adapters: CaseWorkflowAdapter[];
  store: CaseActivationStore;
  runs: WorkflowTriggerStore & {
    pending(context: TenantContext, id: string): Promise<WorkflowTriggerRun[]>;
  };
  triggers: {
    fire(
      context: TenantContext,
      id: string,
      request: WorkflowTriggerRequest,
    ): Promise<WorkflowTriggerRun>;
  };
  steps: {
    record(
      context: TenantContext,
      runId: string,
      output: ProcessStepOutput,
    ): Promise<void>;
    list(
      context: TenantContext,
      runIds: string[],
    ): Promise<Map<string, ProcessStepOutput[]>>;
  };
  catalog: Pick<WorkflowCatalogStore, 'publish'>;
  cases: CaseReader;
  identity: Pick<IdentityService, 'refreshContext' | 'resolveWorkflowContext'> &
    /**
     * Without `suspendedMembers`, a suspended owner isn't reported; their runs still pause.
     * Without `listMembers`, nobody checks that human task roles have someone to answer.
     */
    Partial<Pick<IdentityService, 'suspendedMembers' | 'listMembers'>>;
  policies: Pick<PolicyService, 'approvalRequirement' | 'currentVersion'>;
  audit: { append(entry: WorkflowAuditEntry): Promise<void> };
  transport?: CaseRunTransport;
  enabled: boolean;
  hash(value: unknown): string;
  /** Derives a stable UUID from a value. */
  id(value: string): string;
  now(): Date;
  /** Unfinished runs per workflow; further cases wait. Defaults to 20. */
  maxOpenRuns?: number;
}) {
  const adapters = new Map(
    deps.adapters.map((adapter) => {
      const trigger = adapter.version.applicability.trigger;
      const valid = adapter.signals
        ? trigger.kind === 'event' &&
          trigger.eventType === adapter.version.context.kind &&
          canonicalJson(adapter.version.inputs) ===
            canonicalJson({ activationId: 'string', signalId: 'string' })
        : trigger.kind === 'exception' &&
          canonicalJson(adapter.version.inputs) ===
            canonicalJson({ activationId: 'string', caseId: 'string' });
      if (!valid)
        throw new Error(
          'Case workflows need an exception trigger and case inputs, or an event trigger and signal inputs',
        );

      return [adapter.version.definition.id, adapter] as const;
    }),
  );
  /** The input naming what started a run: a case, or an owner's signal. */
  const inputKey = (found: CaseWorkflowAdapter) =>
    found.signals ? 'signalId' : 'caseId';
  const reader = (found: CaseWorkflowAdapter) => found.signals ?? deps.cases;
  const available = deps.enabled && !!deps.transport;
  const maxOpenRuns = deps.maxOpenRuns ?? 20;
  // Case subjects never change, so each case is mapped once per process.
  const subjects = new Map<string, { kind: string; id: string } | null>();

  async function authorize(
    context: TenantContext,
    permission: Permission = 'workflows.read',
  ) {
    const fresh = await deps.identity.refreshContext(context);
    requireTenant(fresh, context.tenantId);
    requirePermission(fresh, permission);
    if (fresh.actor.id !== context.actor.id)
      throw new IdentityError(403, 'FORBIDDEN', 'Sign in again to continue.');

    return fresh;
  }

  function adapter(id: string) {
    const found = adapters.get(id);
    if (!found)
      throw new IdentityError(404, 'NOT_FOUND', 'Workflow not found.');

    return found;
  }

  function conflict(message: string): never {
    throw new IdentityError(409, 'CONFLICT', message);
  }

  const issueLabel = (version: ProcessWorkflowVersion) =>
    version.context.kind.replaceAll('_', ' ');

  const view = (activation: CaseActivation): WorkflowActivationView => ({
    id: activation.id,
    version: activation.version,
    versionDigest: activation.versionDigest,
    artifactDigest: activation.artifactDigest,
    policyVersion: activation.policyVersion,
    active: activation.active,
    grants: {
      principalIds: [activation.principalId],
      connectionIds: [],
      targetIds: [],
    },
    reviewedBy: activation.principalId,
    reviewedAt: activation.reviewedAt,
  });

  async function recordAudit(
    context: TenantContext,
    activation: CaseActivation,
    revoked: boolean,
  ) {
    await deps.audit.append({
      id: deps.id(`${activation.id}:${revoked}`),
      tenantId: context.tenantId,
      eventKey: `case-workflow:${activation.id}:${revoked}`,
      eventType: revoked ? 'workflow.activation_revoked' : 'workflow.activated',
      schemaVersion: 1,
      occurredAt: revoked ? activation.revokedAt! : activation.reviewedAt,
      actor: {
        kind: 'user',
        id: revoked ? activation.revokedBy! : activation.principalId,
      },
      correlationId: activation.id,
      proposalId: activation.id,
      actionHash: activation.artifactDigest,
      evidenceRefs: [activation.versionDigest],
      details: {
        definitionId: activation.definitionId,
        activationId: activation.id,
        version: activation.version,
      },
    });
  }

  /**
   * The adapter's prerequisites plus one per role its human tasks name: someone active must hold
   * it, or its tasks would have nobody to answer them. Unreadable prerequisites block.
   */
  async function caseRequirements(
    context: TenantContext,
    found: CaseWorkflowAdapter,
  ): Promise<TemplateRequirement[]> {
    const own = await found.requirements(context).catch(() => [unchecked]);
    const roles = [
      ...new Set(
        found.version.steps.flatMap((step) =>
          step.kind === 'human_task'
            ? [step.assignee, step.escalationTarget].flatMap((target) =>
                target.kind === 'role' ? [target.key] : [],
              )
            : [],
        ),
      ),
    ];
    if (!roles.length || !deps.identity.listMembers) return own;
    const members = await deps.identity.listMembers(context).catch(() => null);
    if (!members) return [...own, unchecked];

    return [
      ...own,
      ...roles.map((key): TemplateRequirement => {
        const holders = members.filter((member) => member.role.id === key);
        const name =
          holders[0]?.role.name ?? key.replace(/^./, (c) => c.toUpperCase());
        const met = holders.some((member) => member.status !== 'suspended');

        return {
          label: `Someone with the ${name} role`,
          met,
          detail: met
            ? `People with the ${name} role answer this workflow’s tasks.`
            : `Nobody active has the ${name} role, so this workflow’s tasks would have nobody to answer them. Give someone the role in Team.`,
          fix: null,
        };
      }),
    ];
  }

  async function approval(
    context: TenantContext,
    found: CaseWorkflowAdapter,
  ): Promise<ApprovalBehavior> {
    if (found.approval)
      return typeof found.approval === 'function'
        ? found.approval(context)
        : found.approval;
    const { version } = found;
    const actions = version.steps.filter((step) => step.kind === 'capability');
    if (!actions.length)
      return {
        mode: 'no_actions',
        summary:
          'This workflow doesn’t change connected systems, so nothing needs approval.',
        details: [
          'It reads current state and hands the case to a person when needed.',
        ],
      };

    return describeApproval(
      await deps.policies.approvalRequirement(context.tenantId, {
        minimumRisk: actions.some((step) => step.minimumRisk === 'high')
          ? 'high'
          : actions.some((step) => step.minimumRisk === 'medium')
            ? 'medium'
            : 'low',
      }),
      'change',
    );
  }

  async function recent(context: TenantContext, id: string) {
    const list = await deps.runs.list(context, id);
    const evidence = await deps.steps.list(
      context,
      list.map((run) => run.id),
    );

    return list.map((run) => ({
      run,
      state: presentTriggerRun(run, evidence.get(run.id)).processState,
    }));
  }

  /** The detail shown for a case workflow, with readiness from its adapter and recent runs. */
  async function detail(
    context: TenantContext,
    id: string,
  ): Promise<WorkflowDetail> {
    const found = adapter(id);
    const { version } = found;
    // An unreadable source shows as unknown here instead of failing the workflow list.
    const [activations, requirements, runs, open, policyVersion, connections] =
      await Promise.all([
        deps.store.list(context),
        caseRequirements(context, found),
        recent(context, id),
        reader(found)
          .open(context)
          .catch(() => null),
        deps.policies.currentVersion(context.tenantId),
        found.connections?.(context) ?? Promise.resolve([]),
      ]);
    const mine = activations.filter((item) => item.definitionId === id);
    const active = mine.find((item) => item.active);
    const ownerSuspended =
      !!active &&
      !!(await deps.identity.suspendedMembers?.(context, [active.principalId]))
        ?.size;
    const cases =
      open?.filter((item) => item.issueType === version.context.kind).length ??
      0;
    const waiting = runs.filter((item) => item.state === 'awaiting_decision');
    const issues: ReadinessIssue[] = [
      ...(available
        ? []
        : [
            {
              code: 'worker_unavailable',
              severity: 'blocking' as const,
              message:
                'The workflow worker isn’t connected, so Luma can’t start runs for new cases.',
              scope: null,
              repair: {
                label: 'Ask whoever runs Luma to start the workflow worker',
                destination: 'server' as const,
              },
            },
          ]),
      ...(ownerSuspended
        ? [
            {
              code: 'owner_suspended',
              severity: 'blocking' as const,
              message:
                'This workflow needs a new owner. It runs with the access of the person who turned it on, and their access to this workspace is suspended, so its runs are paused. Turn it off and on again to run it with your access, or wait until their access is restored.',
              scope: null,
              repair: null,
            },
          ]
        : []),
      ...requirements
        .filter((item) => !item.met)
        .map((item) => ({
          code: 'requirement',
          severity: 'blocking' as const,
          message: item.detail,
          scope: null,
          repair: item.fix
            ? {
                label: item.fix.label,
                destination:
                  item.fix.destination === 'connections'
                    ? ('connections' as const)
                    : item.fix.destination === 'procurement'
                      ? ('suppliers' as const)
                      : ('workflow_rules' as const),
              }
            : null,
        })),
    ];
    const blockers = issues.map((item) => item.message);
    const presented = presentProcessVersion(version);
    const unit = found.template.unit ?? `${issueLabel(version)} case`;
    const source = found.signals ? 'its owner reports' : 'detection confirms';

    return {
      presentation: 'workflows.case',
      summary: {
        id,
        name: version.definition.name,
        purpose: version.definition.intent,
        category: version.definition.category,
        capability: presented.capability,
        systems: [
          ...new Set(connections.map((connection) => connection.system)),
        ],
        availableVersion: version.version,
        status: !available
          ? 'unavailable'
          : active
            ? 'active'
            : mine.length
              ? 'revoked'
              : 'inactive',
        blockers,
        activeVersions: active ? [active.version] : [],
        readiness: assessReadiness({
          enablement: active
            ? 'enabled'
            : mine.length
              ? 'paused'
              : 'not_enabled',
          issues,
          coverage: {
            unit: `open ${unit}`,
            covered: active ? cases : 0,
            ready: null,
            explanation: `${
              active
                ? `Luma starts one run for each ${unit} that ${source}.`
                : `No ${unit} starts this workflow until someone turns it on.`
            } ${open ? `${cases} open now.` : 'Luma couldn’t read how many are open right now.'}`,
          },
          approval: await approval(context, found),
          waiting: {
            count: waiting.length,
            repair: waiting.length
              ? { label: 'Open Needs you', destination: 'needs_you' }
              : null,
          },
          outcomes: summarizeOutcomes(
            runs.map(({ run, state }) => ({
              id: run.id,
              createdAt: run.createdAt,
              state,
            })),
            caseRunOutcome,
          ),
          enable: { label: 'Turn on', destination: 'workflow_rules' },
          idle: found.signals
            ? `Luma waits for the next ${unit}, then starts a run.`
            : `Luma waits for detection to confirm the next ${unit}, then starts a run.`,
        }),
      },
      versions: [
        {
          ...presented,
          steps: presented.steps.map((step) => ({
            ...step,
            ...found.stepCopy[step.id],
          })),
          compatible: available,
          blockers,
          category: version.definition.category,
          format: 'workflow/2',
          applicability: version.applicability,
          inputs: version.inputs,
          context: version.context,
          approval:
            (await approval(context, found)).summary ??
            'Each change waits for policy approval by someone else who can approve changes before it is sent.',
        },
      ],
      activations: mine.map(view),
      connections,
      principalId: context.actor.id,
      canManage: hasPermission(context, 'workflows.publish'),
      policyVersion,
      evaluationEvidence: 'unavailable',
    };
  }

  /** Loads and checks a run's binding before any of its steps run. */
  async function bound(run: ProcessRun) {
    const context = await deps.identity.resolveWorkflowContext(
      run.actor.id,
      run.tenantId,
      run.id,
    );
    requireTenant(context, run.tenantId);
    requirePermission(context, 'actions.propose');
    if (run.actor.kind !== 'user' || context.actor.id !== run.actor.id)
      throw new Error('Workflow principal changed');
    const stored = await deps.runs.run(context, run.id);
    const found = adapters.get(run.definitionId);
    if (
      !found ||
      !stored ||
      stored.state !== 'awaiting_admission' ||
      stored.definitionId !== run.definitionId ||
      stored.versionDigest !== run.versionDigest ||
      found.version.digest !== run.versionDigest ||
      stored.contextDigest !== run.contextDigest ||
      stored.actor.id !== run.actor.id ||
      canonicalJson(stored.subject) !== canonicalJson(run.subject) ||
      canonicalJson(stored.context) !== canonicalJson(run.context)
    )
      throw new Error('Workflow run binding changed');
    const activation = (await deps.store.list(context)).find(
      (item) => item.id === run.context.inputs.activationId,
    );
    const caseId = String(run.context.inputs[inputKey(found)]);
    const signal = await reader(found).get(context, caseId);
    if (!activation || activation.definitionId !== run.definitionId || !signal)
      throw new Error('Case run binding changed');
    const caseRun: CaseRun = {
      run,
      activation,
      signal,
      stop: !activation.active
        ? 'activation_revoked'
        : !signal.open
          ? 'case_resolved'
          : null,
      evidence: async () =>
        found.signals ? [] : deps.cases.evidence(context, caseId),
    };

    return { context, adapter: found, caseRun };
  }

  const activities: ProcessActivities = {
    async read(run, step) {
      const { context, adapter: found, caseRun } = await bound(run);
      const outputs = (await deps.steps.list(context, [run.id])).get(run.id);

      return found.read(context, caseRun, step, outputs ?? []);
    },
    // Case workflows have no explicit approval steps; policy approval happens at the action.
    decision: async () => ({ state: 'pending' }),
    async action(run, version, step, outputs) {
      const { context, adapter: found, caseRun } = await bound(run);
      if (
        canonicalJson(version) !== canonicalJson(found.version) ||
        !found.version.steps.some(
          (item) => canonicalJson(item) === canonicalJson(step),
        )
      )
        throw new Error('Action does not belong to this run version');

      return found.action(context, caseRun, step, outputs);
    },
    async verify(run, step, outputs) {
      const { context, adapter: found, caseRun } = await bound(run);

      return found.verify(context, caseRun, step, outputs);
    },
    async record(run, output) {
      const { context, adapter: found } = await bound(run);
      await deps.steps.record(context, run.id, output);
      // Work handed to people keeps a responsible person on the case.
      if (
        found.caseOwner === 'principal' &&
        !found.signals &&
        deps.cases.claim &&
        (output.state === 'escalated' ||
          (output.kind === 'human_task' && output.state === 'waiting'))
      )
        try {
          await deps.cases.claim(
            context,
            String(run.context.inputs.caseId),
            run.actor.id,
          );
        } catch (error) {
          // People without assignment access, or a closed case, keep the case as it is.
          if (
            !(error instanceof IdentityError) ||
            ![403, 404, 409, 422].includes(error.statusCode)
          )
            throw error;
        }
      await deps.audit.append({
        id: deps.id(`${run.id}:${output.stepId}:${output.state}`),
        tenantId: context.tenantId,
        eventKey: `case-workflow:${run.id}:${output.stepId}:${output.state}`,
        eventType:
          output.kind === 'verification'
            ? 'workflow.verification'
            : 'workflow.step_recorded',
        schemaVersion: 1,
        occurredAt: output.recordedAt,
        actor: { kind: 'user', id: context.actor.id },
        correlationId: run.id,
        proposalId: run.id,
        actionHash: deps.hash(output),
        evidenceRefs: output.evidenceRefs,
        details: {
          definitionId: run.definitionId,
          runId: run.id,
          ...run.context.inputs,
          stepId: output.stepId,
          state: output.state,
          ...(output.reason ? { reason: output.reason } : {}),
        },
      });
    },
  };

  /** Starts a run for one case unless one exists. Returns whether a new run was recorded. */
  async function startFor(
    context: TenantContext,
    found: CaseWorkflowAdapter,
    activation: CaseActivation,
    signal: CaseSignal,
  ) {
    const { version } = found;
    const kind = version.applicability.trigger.kind;
    const cached = `${version.definition.id}:${signal.id}`;
    let subject = subjects.get(cached);
    if (subject === undefined) {
      subject = await found.subject(
        context,
        signal,
        found.signals ? [] : await deps.cases.evidence(context, signal.id),
      );
      if (subjects.size > 5000) subjects.clear();
      subjects.set(cached, subject);
    }
    if (!subject) return false;
    const key = deps.hash([
      context.tenantId,
      version.definition.id,
      version.digest,
      subject,
      kind,
      signal.id,
    ]);
    if (await deps.runs.find(context, key)) return false;
    const now = deps.now().toISOString();
    const run = await deps.triggers.fire(context, version.definition.id, {
      version: version.version,
      reviewedDigest: version.digest,
      subject,
      signal: {
        kind: kind === 'event' ? 'event' : 'exception',
        sourceId: signal.id,
        occurredAt: signal.lastDetectedAt,
      },
      context: {
        inputs: { activationId: activation.id, [inputKey(found)]: signal.id },
        evidence: {
          kind: version.context.kind,
          facts: { severity: signal.severity },
          observations: [
            {
              // Owner signal IDs aren't UUIDs; cases are.
              id: found.signals ? deps.id(`signal:${signal.id}`) : signal.id,
              observedAt: signal.lastDetectedAt,
              source: `${found.signals ? 'signal' : 'case'}:${signal.issueType}`,
            },
          ],
        },
        provenance: {
          reference: `${found.signals ? 'signal' : 'case'}:${signal.id}`,
          capturedAt: now,
        },
      },
    });
    await deps.transport!.start(context, run, version);

    return true;
  }

  const templates: TemplateSource[] = [...adapters.values()].map((found) => ({
    id: found.version.definition.id,
    async template(context) {
      const { version } = found;
      const [requirements, current] = await Promise.all([
        caseRequirements(context, found),
        detail(context, version.definition.id),
      ]);
      const all: TemplateRequirement[] = [
        {
          label: 'Workflow worker connected',
          met: available,
          detail: available
            ? 'Case workflows run on the workflow worker.'
            : 'The workflow worker isn’t running on this Luma server. Whoever runs the server needs to start it.',
          fix: null,
        },
        ...requirements,
      ];

      return {
        id: version.definition.id,
        name: version.definition.name,
        purpose: version.definition.intent,
        category: version.definition.category as WorkflowTemplate['category'],
        trigger: found.template.trigger,
        steps: found.template.steps,
        success: found.template.success,
        requirements: all,
        readiness: templateReadiness(all),
        status: current.summary.status,
        configure: 'case',
        installed: !!(await deps.runs.version(
          context,
          version.definition.id,
          version.version,
        )),
        version: version.version,
        digest: version.digest,
      };
    },
    content: () => draftFromVersion(found.version),
    async install(context) {
      await deps.catalog.publish(
        await authorize(context, 'workflows.publish'),
        found.version,
      );
    },
  }));

  return {
    /** Rechecks the original native activation, principal, immutable run binding and nonterminal state. */
    async runCurrent(context: TenantContext, runId: string): Promise<boolean> {
      context = await authorize(context);
      const run = await deps.runs.run(context, runId);
      if (!run) return false;
      const loaded = await bound(run).catch(() => null);
      if (!loaded || loaded.caseRun.stop) return false;
      const activation = loaded.caseRun.activation;
      if (
        activation.principalId !== run.actor.id ||
        activation.versionDigest !== run.versionDigest ||
        activation.version !== run.version ||
        activation.artifactDigest !==
          deps.hash({
            definitionId: activation.definitionId,
            versionDigest: activation.versionDigest,
            principalId: activation.principalId,
            policyVersion: activation.policyVersion,
            scope: 'workspace',
          })
      )
        return false;
      const outputs = (await deps.steps.list(context, [runId])).get(runId);
      const state = presentTriggerRun(run, outputs).processState;

      return !state || openStates.has(state);
    },
    /** Wakes a reviewed native run as its original principal; it never authorizes or dispatches an action. */
    async notifyDecision(
      context: TenantContext,
      runId: string,
    ): Promise<boolean> {
      context = await authorize(context, 'decisions.respond');
      requireChangesAllowed(context);
      if (
        !deps.transport?.notifyDecision ||
        !(await this.runCurrent(context, runId))
      )
        return false;
      const run = await deps.runs.run(context, runId);
      if (!run) return false;
      const loaded = await bound(run);
      await deps.transport.notifyDecision(loaded.context, run);

      return true;
    },
    activities,
    templates,
    /** Whether a definition ID belongs to a case workflow. */
    owns: (id: string) => adapters.has(id),
    /** Lists each workflow's 50 most recent runs with the case that started them, newest first. */
    async caseRuns(context: TenantContext) {
      context = await authorize(context);
      const found = await Promise.all(
        [...adapters.values()]
          .filter((item) => !item.signals)
          .map(async ({ version }) =>
            (await recent(context, version.definition.id)).map(
              ({ run, state }) => ({
                caseId: String(run.context.inputs.caseId),
                definitionId: version.definition.id,
                name: version.definition.name,
                runId: run.id,
                createdAt: run.createdAt,
                state: state ?? null,
              }),
            ),
          ),
      );

      return found
        .flat()
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    /**
     * Lists runs that handed an owner's follow-up to a person and ask through Needs you, while
     * the follow-up is still open. Each run appears once, from its 50 most recent runs.
     */
    async handovers(context: TenantContext): Promise<WorkflowHandover[]> {
      context = await authorize(context);
      const found = await Promise.all(
        [...adapters.values()]
          .filter((item) => item.signals && item.handover !== 'owner')
          .map(async (item) => {
            const runs = await deps.runs.list(
              context,
              item.version.definition.id,
            );
            const outputs = await deps.steps.list(
              context,
              runs.map((run) => run.id),
            );
            const handed = runs.filter(
              (run) =>
                presentTriggerRun(run, outputs.get(run.id)).processState ===
                'escalated',
            );
            const items = await Promise.all(
              handed.map(async (run): Promise<WorkflowHandover | null> => {
                const signal = await item.signals!.get(
                  context,
                  String(run.context.inputs.signalId),
                );
                if (!signal?.open) return null;
                const last = (outputs.get(run.id) ?? []).at(-1);

                return {
                  definitionId: item.version.definition.id,
                  name: item.version.definition.name,
                  runId: run.id,
                  handedOverAt: last?.recordedAt ?? run.createdAt,
                  reason: last?.reason ?? null,
                  signal,
                };
              }),
            );

            return items.filter((entry) => entry !== null);
          }),
      );

      return found.flat();
    },
    /** Lists the summaries shown in the workflow library. */
    async summaries(context: TenantContext) {
      context = await authorize(context);

      return Promise.all(
        [...adapters.keys()].map(
          async (id) => (await detail(context, id)).summary,
        ),
      );
    },
    async detail(context: TenantContext, id: string) {
      return detail(await authorize(context), id);
    },
    /**
     * Turns a workflow on for the workspace, acting as the caller. The caller reviews the exact
     * version and approval policy. Resending the same ID is safe; it never widens authority.
     */
    async activate(
      context: TenantContext,
      id: string,
      input: {
        id: string;
        version: string;
        reviewedDigest: string;
        policyVersion: string;
      },
    ) {
      context = await authorize(context, 'workflows.publish');
      const found = adapter(id);
      const existing = (await deps.store.list(context)).find(
        (item) => item.id === input.id,
      );
      if (existing) {
        if (
          existing.definitionId !== id ||
          existing.principalId !== context.actor.id ||
          existing.versionDigest !== input.reviewedDigest
        )
          conflict('This activation ID belongs to another request.');

        return view(existing);
      }
      if (!available)
        throw new IdentityError(
          503,
          'SERVICE_UNAVAILABLE',
          'The workflow worker isn’t connected. Ask whoever runs Luma to start it.',
        );
      if (
        input.version !== found.version.version ||
        input.reviewedDigest !== found.version.digest
      )
        conflict('The reviewed version changed. Reload the workflow.');
      if (
        input.policyVersion !==
        (await deps.policies.currentVersion(context.tenantId))
      )
        conflict('The approval policy changed. Review it again.');
      const missing = (await caseRequirements(context, found)).find(
        (item) => !item.met,
      );
      if (missing) conflict(missing.detail);
      await deps.catalog.publish(context, found.version);
      const reviewedAt = deps.now().toISOString();
      const activation = await deps.store.insert(context, {
        id: input.id,
        definitionId: id,
        version: found.version.version,
        versionDigest: found.version.digest,
        principalId: context.actor.id,
        policyVersion: input.policyVersion,
        artifactDigest: deps.hash({
          definitionId: id,
          versionDigest: found.version.digest,
          principalId: context.actor.id,
          policyVersion: input.policyVersion,
          scope: 'workspace',
        }),
        active: true,
        reviewedAt,
        revokedAt: null,
        revokedBy: null,
      });
      if (activation.reviewedAt === reviewedAt)
        await recordAudit(context, activation, false);

      return view(activation);
    },
    /** Turns the workflow off. Runs already waiting can reconcile but send no new change. */
    async revoke(
      context: TenantContext,
      id: string,
      activationId: string,
      digest: string,
    ) {
      context = await authorize(context, 'workflows.publish');
      adapter(id);
      const current = (await deps.store.list(context)).find(
        (item) => item.id === activationId && item.definitionId === id,
      );
      if (!current)
        throw new IdentityError(404, 'NOT_FOUND', 'Activation not found.');
      if (current.artifactDigest !== digest)
        conflict(
          'The reviewed activation changed. Refresh before turning it off.',
        );
      if (!current.active) return view(current);
      const revoked = await deps.store.revoke(
        context,
        activationId,
        context.actor.id,
        deps.now().toISOString(),
      );
      if (!revoked)
        throw new IdentityError(404, 'NOT_FOUND', 'Activation not found.');
      await recordAudit(context, revoked, true);

      return view(revoked);
    },
    /**
     * Recovers committed starts, then starts runs for open cases that detection confirmed
     * recently. Runs as the activating principal; other principals' runs are left to them.
     */
    async tick(context: TenantContext) {
      // Runs prepare actions as the activating principal; admission checks execution.
      context = await authorize(context, 'actions.propose');
      if (!available) return;
      const activations = (await deps.store.list(context)).filter(
        (item) => item.principalId === context.actor.id,
      );
      if (!activations.length) return;
      let open: CaseSignal[] | undefined;
      const failures: unknown[] = [];
      // One workflow's unreadable source must not keep the others from starting runs.
      for (const found of adapters.values())
        await advance(found).catch((error: unknown) => failures.push(error));
      if (failures.length)
        throw new AggregateError(failures, 'Some case workflows could not run');

      async function advance(found: CaseWorkflowAdapter) {
        const id = found.version.definition.id;
        if (!activations.some((item) => item.definitionId === id)) return;
        const pending = await deps.runs.pending(context, id);
        const evidence = await deps.steps.list(
          context,
          pending.map((run) => run.id),
        );
        for (const run of pending) {
          if (run.actor.id !== context.actor.id) continue;
          const state = presentTriggerRun(
            run,
            evidence.get(run.id),
          ).processState;
          if (!state || openStates.has(state))
            await deps.transport!.start(context, run, found.version);
        }
        const activation = activations.find(
          (item) => item.definitionId === id && item.active,
        );
        if (!activation) return;
        let capacity = maxOpenRuns - pending.length;
        if (capacity <= 0) return;
        const signals = found.signals
          ? await found.signals.open(context)
          : (open ??= await deps.cases.open(context));
        const now = deps.now().getTime();
        const candidates = signals
          .filter(
            (signal) =>
              signal.issueType === found.version.context.kind &&
              caseStartable(signal, found.version.context.maxAgeSeconds, now),
          )
          .sort((a, b) => a.firstDetectedAt.localeCompare(b.firstDetectedAt));
        for (const signal of candidates) {
          if (capacity <= 0) break;
          if (await startFor(context, found, activation, signal)) capacity--;
        }
      }
    },
  };
}

export type CaseWorkflows = ReturnType<typeof createCaseWorkflows>;
