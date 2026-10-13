import type { IdentityService, TenantContext } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';

import { createProcessActivities } from '../application/process-activities.js';
import type { CodeProcessBusinessAdapter } from '../application/process-business.js';
import type { ProcessRun, ProcessWorkflowVersion } from '../domain/process.js';
import type { VocabularyContribution } from '../domain/vocabulary.js';
import type {
  PublishedWorkflowVersion,
  WorkflowTriggerRun,
} from '../domain/workflow.js';
import { createCodeJournal } from './code/journal.js';
import { createWasmtimeRunner } from './code/runner.js';
import { createProcessStepStore } from './process-store.js';
import { createWorkflowTriggerStore } from './triggers.js';

/** Starts committed computation workflows on the existing durable process worker. */
export interface CodeProcessTransport {
  start(
    context: TenantContext,
    run: ProcessRun,
    version: ProcessWorkflowVersion,
  ): Promise<unknown>;
}

/** Provides the native computation adapter. Business capabilities require their own admission adapter. */
export function createCodeProcesses(
  db: TenantDatabase,
  identity: Pick<IdentityService, 'resolveWorkflowContext'>,
  transport?: CodeProcessTransport,
  business?: CodeProcessBusinessAdapter,
) {
  const directory = process.env.LUMA_CODE_RUNTIME_DIR;
  const runs = createWorkflowTriggerStore(db);
  const steps = createProcessStepStore(db);
  const resolveContext = (run: ProcessRun) =>
    identity.resolveWorkflowContext(run.actor.id, run.tenantId, run.id);
  const supported = (
    version: PublishedWorkflowVersion,
  ): version is ProcessWorkflowVersion =>
    !!transport &&
    version.format === 'workflow/2' &&
    version.steps.some(
      (step) =>
        step.kind === 'code' ||
        step.kind === 'human_task' ||
        step.kind === 'event_wait' ||
        business?.supports(step),
    ) &&
    version.steps.every(
      (step) =>
        ([
          'code',
          'condition',
          'wait',
          'end',
          'escalation',
          'human_task',
          'event_wait',
        ].includes(step.kind) ||
          business?.supports(step)) &&
        (step.kind !== 'code' || (!!directory && !step.grants.length)),
    );
  const unavailable = async (): Promise<never> => {
    throw new Error('This capability requires an installed business adapter');
  };
  const activities = createProcessActivities({
    resolveContext,
    loadRun: runs.run,
    loadVersion: async (context, id, version) => {
      const item = await runs.version(context, id, version);

      return item && supported(item) ? item : null;
    },
    admission: business?.admission ?? {
      get: unavailable,
      execute: unavailable,
      reconcile: unavailable,
    },
    bindAction: business?.bindAction ?? unavailable,
    read: business?.read ?? unavailable,
    decision: business?.decision ?? unavailable,
    verify: business?.verify ?? unavailable,
    record: steps.record,
    ...(directory
      ? {
          code: {
            runner: createWasmtimeRunner({ directory }),
            journal: createCodeJournal(db, resolveContext),
          },
        }
      : {}),
  });

  async function start(context: TenantContext, run: WorkflowTriggerRun) {
    const version = await runs.version(context, run.definitionId, run.version);
    if (!version || !supported(version) || run.state !== 'awaiting_admission')
      return;
    await transport!.start(context, run, version);
  }

  const coordinationReason = !transport
    ? 'The workflow worker is unavailable.'
    : undefined;
  const reason = !directory
    ? 'Code Steps aren’t installed on this Luma server. Whoever runs the server needs to install the Code Step runtime.'
    : !transport
      ? 'The workflow worker isn’t running on this Luma server, so custom workflows can’t run. Whoever runs the server needs to start it.'
      : undefined;

  return {
    activities,
    supported,
    start,
    /** Describes the computation steps this adapter runs in workflows that contain a Code Step. */
    async vocabulary(context?: TenantContext): Promise<VocabularyContribution> {
      const executable = !!transport;
      const contribution =
        context && business ? await business.vocabulary(context) : {};

      return {
        reads: contribution.reads ?? [],
        capabilities: contribution.capabilities ?? [],
        evaluators: contribution.evaluators ?? [],
        triggers: [
          ...(['manual', 'event', 'condition', 'exception'] as const).map(
            (kind) => ({
              kind,
              executable,
              ...(coordinationReason ? { reason: coordinationReason } : {}),
            }),
          ),
          {
            kind: 'schedule',
            executable,
          },
        ],
        stepKinds: [
          ...(contribution.stepKinds ?? []),
          ...(
            [
              'code',
              'condition',
              'wait',
              'escalation',
              'end',
              'human_task',
              'event_wait',
            ] as const
          ).map((kind) => ({
            kind,
            executable,
            ...(coordinationReason ? { reason: coordinationReason } : {}),
          })),
        ],
        subjects: [
          ...(contribution.subjects ?? []),
          {
            kind: 'purchase_order',
            label: 'Purchase order',
            description: 'A purchase order recorded in Procurement.',
            executable,
            reason: transport ? null : 'The workflow worker is unavailable.',
          },
        ],
        codeSteps: {
          executable: !reason,
          reason: reason ?? null,
          evaluation: !!directory,
        },
      };
    },
    /** Recovers committed starts using the transport's stable workflow ID. */
    async tick(context: TenantContext, definitionId: string) {
      for (const run of await runs.pending(context, definitionId))
        if (run.actor.id === context.actor.id) await start(context, run);
    },
  };
}
