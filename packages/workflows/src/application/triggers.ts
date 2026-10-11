import type { Permission, TenantContext } from '@luma/identity';
import {
  IdentityError,
  requireChangesAllowed,
  requirePermission,
  requireTenant,
} from '@luma/identity';

import type { PlaybookSnapshot } from '../domain/playbook.js';
import { validateTriggerSignal } from '../domain/trigger.js';
import type {
  PublishedWorkflowVersion,
  WorkflowSubscription,
  WorkflowTrigger,
  WorkflowTriggerRequest,
  WorkflowTriggerRun,
} from '../domain/workflow.js';

/** Persists immutable trigger evidence with atomic deduplication per version, source and subject. */
export interface WorkflowTriggerStore {
  subscription?(
    context: TenantContext,
    id: string,
  ): Promise<WorkflowSubscription | null>;
  subscriptions?(
    context: TenantContext,
    definitionId: string,
  ): Promise<WorkflowSubscription[]>;
  saveSubscription?(
    context: TenantContext,
    input: WorkflowSubscription,
    expected: number,
  ): Promise<WorkflowSubscription>;

  version(
    context: TenantContext,
    id: string,
    version: string,
  ): Promise<PublishedWorkflowVersion | null>;
  find(context: TenantContext, key: string): Promise<WorkflowTriggerRun | null>;
  run(context: TenantContext, id: string): Promise<WorkflowTriggerRun | null>;
  insert(
    context: TenantContext,
    key: string,
    run: WorkflowTriggerRun,
  ): Promise<WorkflowTriggerRun>;
  list(context: TenantContext, id: string): Promise<WorkflowTriggerRun[]>;
  cancel(
    context: TenantContext,
    id: string,
    runId: string,
  ): Promise<WorkflowTriggerRun | null>;
}

/** Starts subject-based runs; every action still requires separate execution admission. */
export function createWorkflowTriggers(deps: {
  store: WorkflowTriggerStore;
  refreshContext(context: TenantContext): Promise<TenantContext>;
  parseSnapshot(
    input: unknown,
    version: PublishedWorkflowVersion,
  ): PlaybookSnapshot;
  hash(input: unknown): string;
  id(): string;
  now(): Date;
}) {
  async function authorize(context: TenantContext, permission: Permission) {
    const fresh = await deps.refreshContext(context);
    requireTenant(fresh, context.tenantId);
    requirePermission(fresh, permission);
    if (permission === 'workflows.triggers.manage')
      requireChangesAllowed(fresh);
    if (fresh.actor.id !== context.actor.id)
      throw new IdentityError(403, 'FORBIDDEN', 'Sign in again to continue.');

    return fresh;
  }

  function same(run: WorkflowTriggerRun, digest: string) {
    if (run.requestDigest !== digest)
      throw new IdentityError(
        409,
        'CONFLICT',
        'This source already started a run with different evidence. Reuse the original request.',
      );

    return run;
  }

  return {
    /** Lists current subscriptions; historical revisions remain bound to their runs. */
    async subscriptions(context: TenantContext, id: string) {
      context = await authorize(context, 'workflows.read');
      if (!deps.store.subscriptions)
        throw new IdentityError(
          503,
          'SERVICE_UNAVAILABLE',
          'Subscriptions are unavailable.',
        );

      return deps.store.subscriptions(context, id);
    },
    /** Adds an immutable revision without changing published logic or historical runs. */
    async configureSubscription(
      context: TenantContext,
      id: string,
      input: {
        id: string;
        revision: number;
        version: string;
        reviewedDigest: string;
        trigger: WorkflowTrigger;
        active: boolean;
      },
    ) {
      context = await authorize(context, 'workflows.triggers.manage');
      if (!deps.store.saveSubscription)
        throw new IdentityError(
          503,
          'SERVICE_UNAVAILABLE',
          'Subscriptions are unavailable.',
        );
      const version = await deps.store.version(context, id, input.version);
      if (!version || version.digest !== input.reviewedDigest)
        throw new IdentityError(
          409,
          'CONFLICT',
          'Review the current workflow version.',
        );
      if (
        version.format !== 'workflow/2' ||
        version.applicability.trigger.kind === 'exception'
      )
        throw new IdentityError(
          409,
          'CONFLICT',
          'This workflow uses its domain activation.',
        );
      if (
        input.trigger.kind === 'exception' ||
        (input.trigger.kind === 'condition' &&
          version.context.fields[input.trigger.field] !==
            (input.trigger.equals === null
              ? 'null'
              : typeof input.trigger.equals)) ||
        (input.trigger.kind === 'schedule' &&
          Date.parse(input.trigger.at) <= deps.now().getTime())
      )
        throw new IdentityError(
          422,
          'VALIDATION_ERROR',
          'The subscription does not match this workflow’s context or schedule.',
        );

      return deps.store.saveSubscription(
        context,
        {
          id: input.id,
          definitionId: id,
          version: version.version,
          versionDigest: version.digest,
          revision: input.revision + 1,
          trigger: input.trigger,
          active: input.active,
          updatedBy: context.actor.id,
          updatedAt: deps.now().toISOString(),
        },
        input.revision,
      );
    },
    /** Records a signal exactly once. Retrying cannot change the bound evidence or version. */
    async fire(
      context: TenantContext,
      id: string,
      request: WorkflowTriggerRequest,
    ) {
      context = await authorize(context, 'workflows.triggers.manage');
      const version = await deps.store.version(context, id, request.version);
      if (!version)
        throw new IdentityError(
          404,
          'NOT_FOUND',
          'Workflow version not found.',
        );
      if (version.digest !== request.reviewedDigest)
        throw new IdentityError(
          409,
          'CONFLICT',
          'The reviewed version changed. Reload the workflow.',
        );
      const subscription = request.subscription
        ? await deps.store.subscription?.(context, request.subscription.id)
        : null;
      if (
        request.subscription &&
        (!subscription ||
          !subscription.active ||
          subscription.definitionId !== id ||
          subscription.revision !== request.subscription.revision ||
          subscription.versionDigest !== version.digest)
      )
        throw new IdentityError(
          409,
          'CONFLICT',
          'This subscription changed. Review it again.',
        );
      const trigger = subscription?.trigger ?? version.applicability.trigger;
      const key = deps.hash([
        context.tenantId,
        id,
        version.digest,
        request.subject,
        ...(subscription ? [subscription.id, subscription.revision] : []),
        trigger.kind,
        trigger.kind === 'schedule' ? trigger.at : request.signal.sourceId,
      ]);
      const requestDigest = deps.hash({
        ...request,
        actorId: context.actor.id,
      });
      const existing = await deps.store.find(context, key);
      if (existing) return same(existing, requestDigest);
      let snapshot: PlaybookSnapshot;
      const now = deps.now();
      try {
        snapshot = deps.parseSnapshot(request.context, version);
        validateTriggerSignal(
          subscription
            ? {
                ...version,
                applicability: { ...version.applicability, trigger },
              }
            : version,
          request.subject,
          request.signal,
          snapshot,
          now.getTime(),
        );
      } catch (error) {
        throw new IdentityError(
          409,
          'CONFLICT',
          error instanceof Error
            ? error.message
            : 'Trigger evidence is invalid.',
        );
      }
      const run: WorkflowTriggerRun = {
        ...(subscription ? { subscription } : {}),
        activationId: null,
        artifactDigest: null,
        id: deps.id(),
        tenantId: context.tenantId,
        definitionId: id,
        version: version.version,
        versionDigest: version.digest,
        trigger,
        subject: request.subject,
        actor: { kind: 'user', id: context.actor.id },
        context: snapshot,
        contextDigest: deps.hash(snapshot),
        evidence: {
          sourceId: request.signal.sourceId,
          occurredAt: request.signal.occurredAt,
        },
        requestDigest,
        createdAt: now.toISOString(),
        state: trigger.kind === 'schedule' ? 'scheduled' : 'awaiting_admission',
        triggeredAt: trigger.kind === 'schedule' ? null : now.toISOString(),
      };

      return same(await deps.store.insert(context, key, run), requestDigest);
    },
    /** Lists the latest scoped runs, including scheduled and cancelled starts. */
    async list(context: TenantContext, id: string) {
      return deps.store.list(await authorize(context, 'workflows.read'), id);
    },
    /** Cancels a pending scheduled start. A run that already fired cannot be cancelled here. */
    async cancel(context: TenantContext, id: string, runId: string) {
      const run = await deps.store.cancel(
        await authorize(context, 'workflows.triggers.manage'),
        id,
        runId,
      );
      if (!run)
        throw new IdentityError(
          409,
          'CONFLICT',
          'This scheduled start is no longer pending. Refresh its status.',
        );

      return run;
    },
  };
}
