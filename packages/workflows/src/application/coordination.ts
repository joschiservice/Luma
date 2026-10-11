import type { TenantContext } from '@luma/identity';
import {
  IdentityError,
  requireChangesAllowed,
  requirePermission,
  requireTenant,
} from '@luma/identity';

import type { HumanTask, WorkflowEvent } from '../domain/coordination.js';
import { validateHumanTaskAnswer } from '../domain/coordination.js';
import type {
  HumanTaskAnswer,
  ProcessRun,
  TaskAssignee,
} from '../domain/process.js';
import type { ProcessActivities } from './process-runtime.js';

/** Persistence serializes answers, deadline changes and cancellation against the authoritative run. */
export interface CoordinationStore {
  coordinate(
    context: TenantContext,
    ...args: Parameters<NonNullable<ProcessActivities['coordinate']>>
  ): ReturnType<NonNullable<ProcessActivities['coordinate']>>;
  task(
    context: TenantContext,
    runId: string,
    stepId: string,
  ): Promise<HumanTask | null>;
  pending(context: TenantContext): Promise<HumanTask[]>;
  answer(
    context: TenantContext,
    task: HumanTask,
    answer: HumanTaskAnswer,
  ): Promise<HumanTask>;
  deliver(context: TenantContext, event: WorkflowEvent): Promise<void>;
}

/** Connects durable waits to tenant-scoped human responses and immutable event delivery. */
export function createWorkflowCoordination(deps: {
  store: CoordinationStore;
  refreshContext(context: TenantContext): Promise<TenantContext>;
  resolveContext(run: ProcessRun): Promise<TenantContext>;
  members(context: TenantContext): Promise<
    {
      userId: string;
      role: { id: string };
      status?: string | undefined;
      accountDisabled?: boolean | undefined;
    }[]
  >;
}) {
  async function authorize(context: TenantContext, change = false) {
    const fresh = await deps.refreshContext(context);
    requireTenant(fresh, context.tenantId);
    requirePermission(fresh, 'workflows.read');
    if (fresh.actor.id !== context.actor.id)
      throw new IdentityError(403, 'FORBIDDEN', 'Sign in again to continue.');
    if (change) requireChangesAllowed(fresh);

    return fresh;
  }

  const matches = (context: TenantContext, assignee: TaskAssignee) =>
    assignee.kind === 'person'
      ? context.actor.id === assignee.id
      : context.actor.role.id === assignee.key;

  return {
    /** Activities register a task once and return its persisted answer after any worker restart. */
    coordinate: async (
      ...args: Parameters<NonNullable<ProcessActivities['coordinate']>>
    ) => {
      const context = await deps.resolveContext(args[0]);
      requireTenant(context, args[0].tenantId);
      if (context.actor.id !== args[0].actor.id)
        throw new Error('Workflow principal changed');
      if (
        args[1].kind === 'human_task' &&
        !(await deps.store.task(context, args[0].id, args[1].id))
      ) {
        const members = (await deps.members(context)).filter(
          (member) => member.status !== 'suspended' && !member.accountDisabled,
        );
        for (const target of [args[1].assignee, args[1].escalationTarget])
          if (
            !members.some((member) =>
              target.kind === 'person'
                ? member.userId === target.id
                : member.role.id === target.key,
            )
          )
            throw new Error(
              'Choose an active workspace person or role for the task.',
            );
      }

      return deps.store.coordinate(context, ...args);
    },
    /** Lists tasks assigned to this member or their current role, including overdue tasks. */
    async pending(context: TenantContext) {
      context = await authorize(context);

      return (await deps.store.pending(context)).filter((task) =>
        matches(context, task.assignee),
      );
    },
    /** Reads the published contract and answer. Unassigned readers cannot inspect another task. */
    async task(context: TenantContext, runId: string, stepId: string) {
      context = await authorize(context);
      const task = await deps.store.task(context, runId, stepId);
      if (
        !task ||
        (!matches(context, task.assignee) &&
          !matches(context, task.escalationTarget))
      )
        throw new IdentityError(404, 'NOT_FOUND', 'Human task not found.');

      return task;
    },
    /** Answers once as the current assignee or escalation role; provider effects still require admission. */
    async answer(
      context: TenantContext,
      runId: string,
      stepId: string,
      answer: HumanTaskAnswer,
    ) {
      context = await authorize(context, true);
      const task = await deps.store.task(context, runId, stepId);
      if (!task)
        throw new IdentityError(404, 'NOT_FOUND', 'Human task not found.');
      if (
        !matches(context, task.assignee) &&
        !matches(context, task.escalationTarget)
      )
        throw new IdentityError(
          403,
          'FORBIDDEN',
          'Only the assigned person or escalation target can answer.',
        );
      try {
        validateHumanTaskAnswer(task, answer);
      } catch (error) {
        throw new IdentityError(
          422,
          'VALIDATION_ERROR',
          error instanceof Error ? error.message : 'Invalid answer.',
        );
      }

      return deps.store.answer(context, task, answer);
    },
    /** Records an event before waking any run; replaying the same source cannot change its evidence. */
    async deliver(context: TenantContext, event: WorkflowEvent) {
      context = await authorize(context, true);
      requirePermission(context, 'workflows.triggers.manage');

      return deps.store.deliver(context, event);
    },
  };
}
