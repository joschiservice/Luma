import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type {
  IdentityService,
  Permission,
  TenantContext,
} from '@luma/identity';
import {
  IdentityError,
  MembershipSuspendedError,
  requirePermission,
  WorkspaceInactiveError,
} from '@luma/identity';
import type { Observability } from '@luma/platform';
import type {
  ExceptionActivities,
  ExceptionWorkflowInput,
  WorkflowProgress,
  WorkflowSource,
} from '@luma/resolution';
import { WorkflowInputError } from '@luma/resolution';
import { metrics } from '@opentelemetry/api';
import { Context, log } from '@temporalio/activity';
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
import type { OpenTelemetryPluginOptions } from '@temporalio/interceptors-opentelemetry-v2';
import { OpenTelemetryPlugin } from '@temporalio/interceptors-opentelemetry-v2';
import type { NativeConnectionOptions } from '@temporalio/worker';
import { NativeConnection, Worker } from '@temporalio/worker';
import { z } from 'zod';

import {
  membershipSuspendedFailure,
  workspaceInactiveFailure,
} from './workspace-pause.js';

export interface TemporalSettings {
  captureActivityError?: Observability['captureActivityError'];
  telemetry?: OpenTelemetryPluginOptions;
  address: string;
  namespace: string;
  taskQueue: string;
  dataRegion: 'EU';
  tls?: NativeConnectionOptions['tls'];
  apiKey?: string;
}

/** Checks Temporal connection settings before opening a client or worker. */
export function validateSettings(settings: TemporalSettings) {
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
  const compiled = fileURLToPath(new URL('./workflows.js', import.meta.url));

  return existsSync(compiled)
    ? compiled
    : fileURLToPath(new URL('./workflows.ts', import.meta.url));
}

/**
 * Logs and reports original failures before sanitizing errors for Temporal history.
 * Reporting failures do not change activity retry behavior. A suspended or closed workspace,
 * or a suspended acting member, is not a failure: it is reported to the workflow, which
 * pauses, without logging.
 * Wrapped activities must run within a Temporal activity context.
 */
export function temporalActivities<T extends object>(
  activities: T,
  captureActivityError?: Observability['captureActivityError'],
): T {
  return Object.fromEntries(
    Object.entries(activities).map(([name, fn]) => [
      name,
      async (...args: unknown[]) => {
        try {
          return await (fn as (...args: unknown[]) => Promise<unknown>)(
            ...args,
          );
        } catch (error) {
          if (error instanceof WorkspaceInactiveError)
            throw ApplicationFailure.nonRetryable(
              'Workspace is not active',
              workspaceInactiveFailure,
            );
          if (error instanceof MembershipSuspendedError)
            throw ApplicationFailure.nonRetryable(
              'Acting member is suspended',
              membershipSuspendedFailure,
            );
          log.error('Workflow activity failed before sanitization', { error });
          try {
            const info = Context.current().info;
            if (info.workflowExecution)
              captureActivityError?.(error, {
                workflowId: info.workflowExecution.workflowId,
                workflowRunId: info.workflowExecution.runId,
                activityId: info.activityId,
                activityType: info.activityType,
                attempt: info.attempt,
                taskQueue: info.taskQueue,
                namespace: info.namespace,
              });
          } catch {
            log.warn('Workflow activity error reporting failed');
          }
          if (
            (error instanceof IdentityError && error.statusCode !== 503) ||
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
  ) as unknown as T;
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
      plugins: settings.telemetry
        ? [new OpenTelemetryPlugin(settings.telemetry)]
        : [],
      activities: temporalActivities(activities, settings.captureActivityError),
      ...(settings.telemetry
        ? {
            interceptors: {
              activity: [
                (ctx) => ({
                  inbound: {
                    async execute(input, next) {
                      const meter = metrics.getMeter('luma.temporal');
                      const attributes = { activity: ctx.info.activityType };
                      meter
                        .createHistogram('luma.activity.queue.duration', {
                          unit: 's',
                        })
                        .record(
                          Math.max(
                            0,
                            Date.now() -
                              ctx.info.currentAttemptScheduledTimestampMs,
                          ) / 1000,
                          attributes,
                        );
                      meter
                        .createCounter('luma.activity.attempts')
                        .add(1, attributes);
                      if (ctx.info.attempt > 1)
                        meter
                          .createCounter('luma.activity.retries')
                          .add(1, attributes);

                      return next(input);
                    },
                  },
                }),
              ],
            },
          }
        : {}),
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
  /** Checks the permission before and after refreshing; reads pass `null` and need membership only. */
  async function scope(
    context: TenantContext,
    source: WorkflowSource,
    permission: Permission | null,
  ) {
    if (permission) requirePermission(context, permission);
    const fresh = await identity.refreshContext(context);
    if (permission) requirePermission(fresh, permission);
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
    /** Starts an isolated Shadow workflow; retries with the same evaluation ID reuse it. */
    async startShadow(
      context: TenantContext,
      source: WorkflowSource,
      shadow: { id: string; workflow: string },
    ) {
      const scoped = await scope(context, source, 'playbooks.activate');
      const parsed = z
        .object({ id: z.string().uuid(), workflow: z.string().min(1).max(200) })
        .strict()
        .parse(shadow);
      const workflowId = `shadow:${scoped.fresh.tenantId}:${parsed.id}`;
      const shadowRequest = JSON.stringify([
        scoped.fresh.tenantId,
        scoped.fresh.actor.id,
        scoped.source.kind,
        scoped.source.id,
        parsed.workflow,
      ]);
      try {
        await client.workflow.start('exceptionWorkflow', {
          workflowId,
          taskQueue,
          memo: { shadowRequest },
          args: [
            {
              tenantId: scoped.fresh.tenantId,
              userId: scoped.fresh.actor.id,
              requestId: scoped.fresh.requestId,
              source: scoped.source,
              shadow: parsed,
            } satisfies ExceptionWorkflowInput,
          ],
          workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
          workflowIdConflictPolicy: WorkflowIdConflictPolicy.FAIL,
        });
      } catch (error) {
        if (!(error instanceof WorkflowExecutionAlreadyStartedError))
          throw error;
        const existing = await client.workflow.getHandle(workflowId).describe();
        if (existing.memo?.shadowRequest !== shadowRequest)
          throw new WorkflowInputError(
            'Shadow evaluation ID already belongs to a different request',
          );
      }

      return { workflowId };
    },
    async start(
      context: TenantContext,
      source: WorkflowSource,
      resumeExpired = false,
    ) {
      const scoped = await scope(context, source, 'actions.propose');
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
        if (resumeExpired) {
          const handle = client.workflow.getHandle(scoped.id);
          const description = await handle.describe();
          if (description.status.name === 'COMPLETED') {
            const previous = (await handle.result()) as WorkflowProgress;
            if (
              previous.phase === 'denied' &&
              previous.reason === 'proposal_expired'
            ) {
              try {
                await client.workflow.start('exceptionWorkflow', {
                  workflowId: scoped.id,
                  taskQueue,
                  args: [input],
                  workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE,
                  workflowIdConflictPolicy: WorkflowIdConflictPolicy.FAIL,
                });
              } catch (restartError) {
                if (
                  !(
                    restartError instanceof WorkflowExecutionAlreadyStartedError
                  )
                )
                  throw restartError;
              }
            }
          }
        }
      }

      return { workflowId: scoped.id };
    },
    async progress(context: TenantContext, source: WorkflowSource) {
      const { id } = await scope(context, source, null);
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
      const { id } = await scope(context, source, 'decisions.respond');
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
  const client = new Client({
    connection,
    namespace: settings.namespace,
    plugins: settings.telemetry
      ? [new OpenTelemetryPlugin(settings.telemetry)]
      : [],
  });
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
