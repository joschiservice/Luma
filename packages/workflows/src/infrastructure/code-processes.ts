import type { IdentityService, TenantContext } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';

import { createProcessActivities } from '../application/process-activities.js';
import type { ProcessRun, ProcessWorkflowVersion } from '../domain/process.js';
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
) {
  const directory = process.env.LUMA_CODE_RUNTIME_DIR;
  const runs = createWorkflowTriggerStore(db);
  const steps = createProcessStepStore(db);
  const resolveContext = (run: ProcessRun) =>
    identity.resolveWorkflowContext(run.actor.id, run.tenantId, run.id);
  const supported = (
    version: PublishedWorkflowVersion,
  ): version is ProcessWorkflowVersion =>
    !!directory &&
    !!transport &&
    version.format === 'workflow/2' &&
    version.applicability.trigger.kind !== 'schedule' &&
    version.steps.some((step) => step.kind === 'code') &&
    version.steps.every(
      (step) =>
        ['code', 'condition', 'wait', 'end', 'escalation'].includes(
          step.kind,
        ) &&
        (step.kind !== 'code' || !step.grants.length),
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
    admission: {
      get: unavailable,
      execute: unavailable,
      reconcile: unavailable,
    },
    bindAction: unavailable,
    read: unavailable,
    decision: unavailable,
    verify: unavailable,
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

  return {
    activities,
    supported,
    start,
    /** Recovers committed starts using the transport's stable workflow ID. */
    async tick(context: TenantContext, definitionId: string) {
      for (const run of await runs.pending(context, definitionId))
        if (run.actor.id === context.actor.id) await start(context, run);
    },
  };
}
