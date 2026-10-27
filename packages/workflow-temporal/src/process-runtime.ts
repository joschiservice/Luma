import { createHash } from 'node:crypto';

import type { IdentityService, TenantContext } from '@luma/identity';
import { requirePermission, requireTenant } from '@luma/identity';
import type {
  ProcessActivities,
  ProcessExecutionClosure,
  ProcessProgress,
  ProcessRun,
  ProcessStart,
  ProcessWorkflowVersion,
} from '@luma/workflows';
import {
  Client,
  Connection,
  WorkflowExecutionAlreadyStartedError,
  type WorkflowExecutionStatusName,
} from '@temporalio/client';
import { WorkflowIdReusePolicy } from '@temporalio/common';
import { NativeConnection, Worker } from '@temporalio/worker';

import { temporalDataConverter } from './payload-codec.js';
import {
  temporalActivities,
  type TemporalSettings,
  validateSettings,
  workerShutdownGraceTime,
  workflowPath,
} from './runtime.js';
import type {
  StockProtectionActivities,
  StockProtectionWorkflowInput,
} from './stock-protection-workflow.js';

/** Uses one stable Temporal ID for every process run, including uncertain start retries. */
export const processWorkflowId = (tenantId: string, runId: string) =>
  `process-v2:${createHash('sha256')
    .update(JSON.stringify([tenantId, runId]))
    .digest('hex')}`;

const closure: Partial<
  Record<WorkflowExecutionStatusName, ProcessExecutionClosure>
> = {
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  TERMINATED: 'terminated',
  TIMED_OUT: 'timed_out',
};

/** Starts and queries exact published versions; callers must persist the run before starting it. */
function createProcessCommands(
  client: Client,
  taskQueue: string,
  identity: Pick<IdentityService, 'refreshContext'>,
  dataRegion: TemporalSettings['dataRegion'],
) {
  async function scope(context: TenantContext, run: ProcessRun) {
    // Process runs prepare actions as their principal; admission checks execution separately.
    requireTenant(context, run.tenantId);
    requirePermission(context, 'actions.propose');
    const fresh = await identity.refreshContext(context);
    requireTenant(fresh, run.tenantId);
    requirePermission(fresh, 'actions.propose');
    if (fresh.dataRegion !== dataRegion)
      throw new Error('Workflow region rejected');
    if (fresh.actor.id !== context.actor.id || fresh.actor.id !== run.actor.id)
      throw new Error('Workflow principal changed');

    return processWorkflowId(run.tenantId, run.id);
  }

  return {
    /** Starts one durable hold lifecycle per case; retries reuse the existing run. */
    async startStockProtection(context: TenantContext, incidentId: string) {
      const fresh = await identity.refreshContext(context);
      requireTenant(fresh, context.tenantId);
      if (
        fresh.actor.id !== context.actor.id ||
        fresh.dataRegion !== dataRegion
      )
        throw new Error('Stock protection principal changed');
      const input: StockProtectionWorkflowInput = {
        tenantId: fresh.tenantId,
        userId: fresh.actor.id,
        dataRegion,
        incidentId,
      };
      try {
        await client.workflow.start('stockProtectionWorkflow', {
          workflowId: `stock-protection:${fresh.tenantId}:${incidentId}`,
          taskQueue,
          args: [input],
          workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
        });
      } catch (error) {
        if (!(error instanceof WorkflowExecutionAlreadyStartedError))
          throw error;
      }
    },
    /**
     * Starts a committed run under its stable ID. When an execution with that ID already
     * exists, reports whether it has closed so the caller can settle a run that never
     * recorded its final step.
     */
    async start(
      context: TenantContext,
      run: ProcessRun,
      source: ProcessWorkflowVersion,
      timeoutMs?: number,
    ): Promise<ProcessStart> {
      const id = await scope(context, run);
      const version = source;
      if (
        version.digest !== run.versionDigest ||
        version.version !== run.version ||
        version.definition.id !== run.definitionId
      )
        throw new Error('Workflow run version binding changed');
      try {
        if (
          timeoutMs !== undefined &&
          (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
        )
          throw new Error('Invalid start request deadline');
        const start = () =>
          client.workflow.start('processWorkflow', {
            workflowId: id,
            taskQueue,
            args: [{ ...run, dataRegion: context.dataRegion }, version],
            workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
          });
        await (timeoutMs === undefined
          ? start()
          : client.connection.withDeadline(Date.now() + timeoutMs, start));
      } catch (error) {
        if (!(error instanceof WorkflowExecutionAlreadyStartedError))
          throw error;
        // The ID is never reused, so an execution that closed reports how it ended.
        const describe = () => client.workflow.getHandle(id).describe();
        const { status } = await (timeoutMs === undefined
          ? describe()
          : client.connection.withDeadline(Date.now() + timeoutMs, describe));

        return { workflowId: id, closed: closure[status.name] ?? null };
      }

      return { workflowId: id, closed: null };
    },
    async progress(
      context: TenantContext,
      run: ProcessRun,
      timeoutMs?: number,
    ): Promise<ProcessProgress> {
      const id = await scope(context, run);

      const query = () =>
        client.workflow.getHandle(id).query<ProcessProgress>('processProgress');
      if (timeoutMs !== undefined) {
        if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
          throw new Error('Invalid progress query deadline');

        return client.connection.withDeadline(Date.now() + timeoutMs, query);
      }

      return query();
    },
    async notifyDecision(
      context: TenantContext,
      run: ProcessRun,
      timeoutMs = 5000,
    ) {
      const id = await scope(context, run);
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
        throw new Error('Invalid decision notification deadline');
      await client.connection.withDeadline(Date.now() + timeoutMs, () =>
        client.workflow.getHandle(id).signal('processDecisionChanged'),
      );
    },
  };
}

/** Connects an isolated process queue so existing exception workers keep their activity contract. */
export async function createProcessWorker(
  settings: TemporalSettings,
  activities: ProcessActivities,
  stockProtection?: StockProtectionActivities,
) {
  validateSettings(settings);
  const data = temporalDataConverter(settings);
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
      dataConverter: data.converter,
      activities: temporalActivities(
        { ...activities, ...stockProtection },
        settings.captureActivityError,
        settings.dataRegion,
      ),
      shutdownGraceTime: workerShutdownGraceTime,
      ...(settings.maxConcurrentActivities
        ? {
            maxConcurrentActivityTaskExecutions:
              settings.maxConcurrentActivities,
          }
        : {}),
    });

    return {
      run: () => worker.run(),
      shutdown: () => worker.shutdown(),
      close: async () => {
        data.close();
        await connection.close();
      },
    };
  } catch (error) {
    await connection.close();
    throw error;
  }
}

/**
 * Creates a process client without contacting Temporal. The connection opens on the first
 * command, so callers start while Temporal is unreachable and each command fails until it is
 * reachable again. The returned close method releases the connection.
 */
export function createProcessClient(
  settings: TemporalSettings,
  identity: Pick<IdentityService, 'refreshContext'>,
) {
  validateSettings(settings);
  const data = temporalDataConverter(settings);
  const connection = Connection.lazy({
    connectTimeout: '2 seconds',
    address: settings.address,
    ...(settings.tls === undefined ? {} : { tls: settings.tls }),
    ...(settings.apiKey ? { apiKey: settings.apiKey } : {}),
  });
  const client = new Client({
    connection,
    namespace: settings.namespace,
    dataConverter: data.converter,
  });

  return {
    ...createProcessCommands(
      client,
      settings.taskQueue,
      identity,
      settings.dataRegion,
    ),
    close: async () => {
      data.close();
      await connection.close();
    },
  };
}
