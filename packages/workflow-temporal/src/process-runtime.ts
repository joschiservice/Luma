import type { IdentityService, TenantContext } from '@luma/identity';
import { requirePermission, requireTenant } from '@luma/identity';
import type {
  ProcessActivities,
  ProcessProgress,
  ProcessRun,
  ProcessWorkflowVersion,
} from '@luma/workflows';
import {
  Client,
  Connection,
  WorkflowExecutionAlreadyStartedError,
} from '@temporalio/client';
import { WorkflowIdReusePolicy } from '@temporalio/common';
import { NativeConnection, Worker } from '@temporalio/worker';

import {
  temporalActivities,
  type TemporalSettings,
  validateSettings,
  workflowPath,
} from './runtime.js';

/** Uses one stable Temporal ID for every process run, including uncertain start retries. */
export const processWorkflowId = (tenantId: string, runId: string) =>
  `process-v2:${tenantId}:${runId}`;

/** Starts and queries exact published versions; callers must persist the run before starting it. */
export function createProcessCommands(
  client: Client,
  taskQueue: string,
  identity: Pick<IdentityService, 'refreshContext'>,
) {
  async function scope(context: TenantContext, run: ProcessRun) {
    // Process runs prepare actions as their principal; admission checks execution separately.
    requireTenant(context, run.tenantId);
    requirePermission(context, 'actions.propose');
    const fresh = await identity.refreshContext(context);
    requireTenant(fresh, run.tenantId);
    requirePermission(fresh, 'actions.propose');
    if (fresh.actor.id !== context.actor.id || fresh.actor.id !== run.actor.id)
      throw new Error('Workflow principal changed');

    return processWorkflowId(run.tenantId, run.id);
  }

  return {
    async start(
      context: TenantContext,
      run: ProcessRun,
      source: ProcessWorkflowVersion,
    ) {
      const id = await scope(context, run);
      const version = source;
      if (
        version.digest !== run.versionDigest ||
        version.version !== run.version ||
        version.definition.id !== run.definitionId
      )
        throw new Error('Workflow run version binding changed');
      try {
        await client.workflow.start('processWorkflow', {
          workflowId: id,
          taskQueue,
          args: [run, version],
          workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
        });
      } catch (error) {
        if (!(error instanceof WorkflowExecutionAlreadyStartedError))
          throw error;
      }

      return id;
    },
    async progress(
      context: TenantContext,
      run: ProcessRun,
    ): Promise<ProcessProgress> {
      const id = await scope(context, run);

      return client.workflow
        .getHandle(id)
        .query<ProcessProgress>('processProgress');
    },
    async notifyDecision(context: TenantContext, run: ProcessRun) {
      const id = await scope(context, run);
      await client.workflow.getHandle(id).signal('processDecisionChanged');
    },
  };
}

/** Connects an isolated process queue so existing exception workers keep their activity contract. */
export async function createProcessWorker(
  settings: TemporalSettings,
  activities: ProcessActivities,
) {
  validateSettings(settings);
  const connection = await NativeConnection.connect({
    address: settings.address,
    ...(settings.tls === undefined ? {} : { tls: settings.tls }),
    ...(settings.apiKey ? { apiKey: settings.apiKey } : {}),
  });
  try {
    const worker = await Worker.create({
      connection,
      namespace: settings.namespace,
      taskQueue: settings.taskQueue,
      workflowsPath: workflowPath(),
      activities: temporalActivities(activities, settings.captureActivityError),
      shutdownGraceTime: '30 seconds',
    });

    return {
      run: () => worker.run(),
      shutdown: () => worker.shutdown(),
      close: () => connection.close(),
    };
  } catch (error) {
    await connection.close();
    throw error;
  }
}

/** Connects a process client; the returned close method releases its connection. */
export async function createProcessClient(
  settings: TemporalSettings,
  identity: Pick<IdentityService, 'refreshContext'>,
) {
  validateSettings(settings);
  const connection = await Connection.connect({
    connectTimeout: '2 seconds',
    address: settings.address,
    ...(settings.tls === undefined ? {} : { tls: settings.tls }),
    ...(settings.apiKey ? { apiKey: settings.apiKey } : {}),
  });
  const client = new Client({ connection, namespace: settings.namespace });

  return {
    ...createProcessCommands(client, settings.taskQueue, identity),
    close: () => connection.close(),
  };
}
