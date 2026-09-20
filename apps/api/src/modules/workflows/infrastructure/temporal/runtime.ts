import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  Client,
  Connection,
  WorkflowExecutionAlreadyStartedError,
  WorkflowNotFoundError,
} from '@temporalio/client';
import {
  ApplicationFailure,
  WorkflowIdConflictPolicy,
  WorkflowIdReusePolicy,
} from '@temporalio/common';
import type { NativeConnectionOptions } from '@temporalio/worker';
import { NativeConnection, Worker } from '@temporalio/worker';
import { z } from 'zod';

import type { IdentityService, TenantContext } from '#modules/identity/index';
import { IdentityError, requireRole } from '#modules/identity/index';
import type {
  ExceptionActivities,
  ExceptionWorkflowInput,
  WorkflowProgress,
  WorkflowSource,
} from '#modules/workflows/application/runtime';
import { WorkflowInputError } from '#modules/workflows/application/runtime';

export interface TemporalSettings {
  address: string;
  namespace: string;
  taskQueue: string;
  dataRegion: 'EU';
  tls?: NativeConnectionOptions['tls'];
  apiKey?: string;
}

function validateSettings(settings: TemporalSettings) {
  z.object({
    address: z.string().min(1),
    namespace: z.string().min(1),
    taskQueue: z.string().min(1),
    dataRegion: z.literal('EU'),
  }).parse(settings);
}

const sourceSchema = z
  .object({
    kind: z.enum(['detection', 'incident']),
    id: z.string().min(1).max(200),
  })
  .strict();

/** Derives a stable workflow ID from the tenant and detection or incident source. */
export function exceptionWorkflowId(tenantId: string, source: WorkflowSource) {
  return `exception-v1:${createHash('sha256')
    .update(JSON.stringify([tenantId, source.kind, source.id]))
    .digest('hex')}`;
}

/**
 * Returns the compiled workflow entry point when present, otherwise its TypeScript source
 * path.
 */
export function workflowPath() {
  const compiled = fileURLToPath(
    new URL('./exception-workflow.js', import.meta.url),
  );

  return existsSync(compiled)
    ? compiled
    : fileURLToPath(new URL('./exception-workflow.ts', import.meta.url));
}

/** Sanitize failures before Temporal stores them in activity history. */
export function temporalActivities(
  activities: ExceptionActivities,
): ExceptionActivities {
  return Object.fromEntries(
    Object.entries(activities).map(([name, fn]) => [
      name,
      async (...args: unknown[]) => {
        try {
          return await (fn as (...args: unknown[]) => Promise<unknown>)(
            ...args,
          );
        } catch (error) {
          if (
            error instanceof IdentityError ||
            error instanceof WorkflowInputError
          )
            throw ApplicationFailure.nonRetryable(
              'Workflow authorization or input rejected',
              'WorkflowRejected',
            );
          throw ApplicationFailure.retryable(
            'Workflow activity unavailable',
            'WorkflowActivityUnavailable',
          );
        }
      },
    ]),
  ) as unknown as ExceptionActivities;
}

/**
 * Connects a Temporal worker with sanitized activities; the caller owns running, shutdown,
 * and closing the worker.
 */
export async function createExceptionWorker(
  settings: TemporalSettings,
  activities: ExceptionActivities,
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
      activities: temporalActivities(activities),
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

/**
 * Creates tenant-authorized workflow start, approval notification, and progress commands
 * over the supplied Temporal client.
 */
export function createWorkflowCommands(
  client: Client,
  taskQueue: string,
  identity: Pick<IdentityService, 'refreshContext'>,
) {
  async function scope(
    context: TenantContext,
    source: WorkflowSource,
    write = true,
  ) {
    if (write) requireRole(context, ['owner', 'admin']);
    const fresh = await identity.refreshContext(context);
    if (write) requireRole(fresh, ['owner', 'admin']);
    if (
      fresh.tenantId !== context.tenantId ||
      fresh.actor.id !== context.actor.id
    )
      throw new WorkflowInputError('Workflow scope changed');
    const parsed = sourceSchema.parse(source);

    return {
      fresh,
      source: parsed,
      id: exceptionWorkflowId(fresh.tenantId, parsed),
    };
  }

  return {
    async start(context: TenantContext, source: WorkflowSource) {
      const scoped = await scope(context, source);
      const input: ExceptionWorkflowInput = {
        tenantId: scoped.fresh.tenantId,
        userId: scoped.fresh.actor.id,
        requestId: scoped.fresh.requestId,
        source: scoped.source,
      };
      try {
        await client.workflow.start('exceptionWorkflow', {
          workflowId: scoped.id,
          taskQueue,
          args: [input],
          workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
          workflowIdConflictPolicy: WorkflowIdConflictPolicy.FAIL,
        });
      } catch (error) {
        if (!(error instanceof WorkflowExecutionAlreadyStartedError))
          throw error;
      }

      return { workflowId: scoped.id };
    },
    async progress(context: TenantContext, source: WorkflowSource) {
      const { id } = await scope(context, source, false);
      const handle = client.workflow.getHandle(id);
      const description = await handle.describe();
      if (description.status.name === 'COMPLETED')
        return handle.result() as Promise<WorkflowProgress>;
      if (
        ['CANCELLED', 'TERMINATED', 'FAILED', 'TIMED_OUT'].includes(
          description.status.name,
        )
      )
        return {
          phase: 'escalated',
          reason: 'workflow_interrupted',
        } satisfies WorkflowProgress;

      return handle.query<WorkflowProgress>('progress');
    },
    async notifyApproval(context: TenantContext, source: WorkflowSource) {
      const { id } = await scope(context, source);
      await client.workflow.getHandle(id).signal('approvalChanged');
    },
  };
}

/**
 * Connects a Temporal client and returns authorized workflow commands with a close function
 * for its connection.
 */
export async function createExceptionClient(
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
  const commands = createWorkflowCommands(client, settings.taskQueue, identity);

  return {
    ...commands,
    progress: (context: TenantContext, source: WorkflowSource) =>
      connection.withDeadline(Date.now() + 2000, () =>
        commands.progress(context, source),
      ),
    close: () => connection.close(),
  };
}

/** Connect lazily so persisted reads remain available while Temporal is offline. */
export function createDeskWorkflowReader(
  settings: TemporalSettings,
  identity: Pick<IdentityService, 'refreshContext'>,
) {
  let pending: ReturnType<typeof createExceptionClient> | undefined;
  let closed = false;

  return {
    async get(
      context: TenantContext,
      exceptionId: string,
      source: WorkflowSource | null = null,
    ) {
      if (closed) throw new Error('Workflow reader closed');
      pending ??= createExceptionClient(settings, identity).catch((error) => {
        pending = undefined;
        throw error;
      });
      const client = await pending;
      try {
        return await client.progress(
          context,
          source ?? { kind: 'incident', id: exceptionId },
        );
      } catch (error) {
        if (error instanceof WorkflowNotFoundError) return null;
        throw error;
      }
    },
    async close() {
      closed = true;
      const client = await pending?.catch(() => undefined);
      await client?.close();
    },
  };
}
