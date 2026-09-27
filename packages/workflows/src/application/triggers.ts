import type { TenantContext } from '@luma/identity';
import { IdentityError, requireRole, requireTenant } from '@luma/identity';

import type { PlaybookSnapshot } from '../domain/playbook.js';
import { validateTriggerSignal } from '../domain/trigger.js';
import type {
  PublishedWorkflowVersion,
  WorkflowTriggerRequest,
  WorkflowTriggerRun,
} from '../domain/workflow.js';

/** Persists immutable trigger evidence with atomic deduplication per version, source and subject. */
export interface WorkflowTriggerStore {
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
  async function authorize(context: TenantContext, write: boolean) {
    const fresh = await deps.refreshContext(context);
    requireTenant(fresh, context.tenantId);
    requireRole(
      fresh,
      write ? ['owner', 'admin'] : ['owner', 'admin', 'member'],
    );
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
    /** Records a signal exactly once. Retrying cannot change the bound evidence or version. */
    async fire(
      context: TenantContext,
      id: string,
      request: WorkflowTriggerRequest,
    ) {
      context = await authorize(context, true);
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
      const trigger = version.applicability.trigger;
      const key = deps.hash([
        context.tenantId,
        id,
        version.digest,
        request.subject,
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
          version,
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
      return deps.store.list(await authorize(context, false), id);
    },
    /** Cancels a pending scheduled start. A run that already fired cannot be cancelled here. */
    async cancel(context: TenantContext, id: string, runId: string) {
      const run = await deps.store.cancel(
        await authorize(context, true),
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
