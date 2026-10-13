import type { TenantContext } from '@luma/identity';
import {
  IdentityError,
  requireChangesAllowed,
  requirePermission,
  requireTenant,
} from '@luma/identity';

import type { InstalledConnection } from '../domain/installation.js';
import type {
  SourceEnvironmentDeclaration,
  SourceEnvironmentProof,
  SourceEnvironmentReview,
} from '../domain/source-environment.js';

export interface SourceEnvironmentCommand {
  commandId: string;
  expectedRevision: number;
  reviewId: string | null;
  liveOperationsConfirmed: boolean;
  reason: string;
}

export interface SourceEnvironmentRepository {
  declaration(
    tenantId: string,
    connectionId: string,
  ): Promise<SourceEnvironmentDeclaration | null>;
  review(tenantId: string, id: string): Promise<SourceEnvironmentReview | null>;
  retain(tenantId: string, review: SourceEnvironmentReview): Promise<void>;
  change(
    context: TenantContext,
    connectionId: string,
    command: SourceEnvironmentCommand,
    fingerprint: string,
    apply: (
      previous: SourceEnvironmentDeclaration | null,
      connection: InstalledConnection,
    ) => SourceEnvironmentDeclaration | Promise<SourceEnvironmentDeclaration>,
  ): Promise<SourceEnvironmentDeclaration>;
}

/** Composes explicit source reviews, retry-safe declarations and trusted read-only classification. */
export function createSourceEnvironments(deps: {
  repository: SourceEnvironmentRepository;
  refreshContext(context: TenantContext): Promise<TenantContext>;
  connections: { list(context: TenantContext): Promise<InstalledConnection[]> };
  enabled(tenantId: string): Promise<boolean>;
  synthetic(connection: InstalledConnection): boolean;
  installed(
    context: TenantContext,
    connection: InstalledConnection,
  ): Promise<boolean>;
  readEvidence(
    context: TenantContext,
    connection: InstalledConnection,
    signal: AbortSignal,
  ): Promise<SourceEnvironmentReview['observations']>;
  binding(connection: InstalledConnection): string;
  fingerprint(value: unknown): string;
  id(): string;
  now(): Date;
}) {
  async function fresh(context: TenantContext, write = false) {
    const current = await deps.refreshContext(context);
    requireTenant(current, context.tenantId);
    if (current.actor.id !== context.actor.id)
      throw new IdentityError(403, 'FORBIDDEN', 'Actor changed');
    requirePermission(current, 'connections.manage');
    if (write) requireChangesAllowed(current);

    return current;
  }

  async function connection(context: TenantContext, id: string) {
    const owned = (await deps.connections.list(context)).find(
      (item) => item.id === id,
    );
    if (!owned)
      throw new IdentityError(404, 'NOT_FOUND', 'Connection not found');

    return owned;
  }

  async function reviewability(
    context: TenantContext,
    c: InstalledConnection,
  ): Promise<{
    reviewable: boolean;
    reviewBlock:
      | 'synthetic'
      | 'inactive'
      | 'missing_capability'
      | 'app_unavailable'
      | null;
  }> {
    const reviewBlock = deps.synthetic(c)
      ? 'synthetic'
      : c.status !== 'active'
        ? 'inactive'
        : !c.permissions.includes('purchase-orders.read') ||
            !c.granted.includes('purchase-orders.read')
          ? 'missing_capability'
          : !(await deps.installed(context, c))
            ? 'app_unavailable'
            : null;

    return { reviewable: reviewBlock === null, reviewBlock };
  }

  async function classify(
    context: TenantContext,
    id: string,
  ): Promise<SourceEnvironmentProof> {
    requireTenant(context, context.tenantId);
    const c = await connection(context, id);
    const base = {
      connectionId: c.id,
      connectionVersion: c.version,
      credentialVersion: c.credentialVersion,
      sourceBinding: deps.binding(c),
    };
    if (deps.synthetic(c))
      return {
        environment: 'synthetic',
        provenance: {
          ...base,
          basis: 'simulation_manifest',
          declarationRevision: null,
          evidenceId: null,
        },
      };
    const declaration = await deps.repository.declaration(context.tenantId, id);
    if (
      !(await deps.enabled(context.tenantId)) ||
      !(await reviewability(context, c)).reviewable ||
      !declaration ||
      declaration.revoked ||
      declaration.review?.sourceBinding !== base.sourceBinding
    )
      return {
        environment: 'unknown',
        provenance: {
          ...base,
          basis: 'unclassified_source',
          declarationRevision: declaration?.revision ?? null,
          evidenceId: null,
        },
      };

    return {
      environment: 'live',
      provenance: {
        ...base,
        basis: 'reviewed_workspace_declaration',
        declarationRevision: declaration.revision,
        evidenceId: declaration.review.id,
      },
    };
  }

  async function enabled(tenantId: string) {
    if (!(await deps.enabled(tenantId)))
      throw new IdentityError(
        403,
        'FORBIDDEN',
        'Source declarations are unavailable',
      );
  }

  return {
    /** Trusted runtime proof; unchanged declarations remain immutable and simulator proof always wins. */
    classify,
    /** Current connection classifications and declaration revisions, without settings or credentials. */
    async list(context: TenantContext) {
      const current = await fresh(context);
      const released = await deps.enabled(current.tenantId);
      if (!released) return { available: false, items: [] };

      return {
        available: true,
        items: await Promise.all(
          (await deps.connections.list(current)).map(async (c) => ({
            connectionId: c.id,
            label: c.label,
            ...(await reviewability(current, c)),
            ...(await classify(current, c.id)),
            declaration: await deps.repository.declaration(
              current.tenantId,
              c.id,
            ),
          })),
        ),
      };
    },
    /** One bounded provider page establishes authenticated source evidence for the user's declaration. */
    async inspect(context: TenantContext, id: string, signal?: AbortSignal) {
      const current = await fresh(context, true);
      await enabled(current.tenantId);
      const before = await connection(current, id);
      if (!(await reviewability(current, before)).reviewable)
        throw new IdentityError(
          409,
          'CONFLICT',
          'This connection cannot be declared live',
        );
      const deadline = AbortSignal.any([
        AbortSignal.timeout(10_000),
        ...(signal ? [signal] : []),
      ]);
      const observations = await new Promise<
        SourceEnvironmentReview['observations']
      >((resolve, reject) => {
        const abort = () =>
          reject(
            new IdentityError(
              503,
              'SERVICE_UNAVAILABLE',
              'Source review was interrupted',
            ),
          );
        if (deadline.aborted) {
          abort();

          return;
        }
        deadline.addEventListener('abort', abort, { once: true });
        Promise.resolve()
          .then(() => deps.readEvidence(current, before, deadline))
          .then(resolve, reject)
          .finally(() => deadline.removeEventListener('abort', abort));
      }).catch((error: unknown) => {
        if (error instanceof IdentityError) throw error;
        throw new IdentityError(
          503,
          'SERVICE_UNAVAILABLE',
          'Source evidence is unavailable',
        );
      });
      if (deadline.aborted)
        throw new IdentityError(
          503,
          'SERVICE_UNAVAILABLE',
          'Source review was interrupted',
        );
      const after = await connection(current, id);
      const observedAt = deps.now().toISOString();
      if (
        !observations.length ||
        observations.length > 1 ||
        !(await reviewability(current, after)).reviewable ||
        deps.binding(before) !== deps.binding(after) ||
        observations.some(
          (o) =>
            !Number.isFinite(Date.parse(o.observedAt)) ||
            Date.parse(o.observedAt) > Date.parse(observedAt) ||
            Date.parse(observedAt) - Date.parse(o.observedAt) > 300_000,
        )
      )
        throw new IdentityError(
          409,
          'CONFLICT',
          'Fresh source evidence is unavailable; inspect again',
        );
      const review: SourceEnvironmentReview = {
        id: deps.id(),
        connectionId: id,
        actorId: current.actor.id,
        sourceBinding: deps.binding(after),
        connectionVersion: after.version,
        credentialVersion: after.credentialVersion,
        observedAt,
        expiresAt: new Date(deps.now().getTime() + 300_000).toISOString(),
        observations,
      };
      await deps.repository.retain(current.tenantId, review);

      return review;
    },
    /** Requires a fresh exact-source review to declare live; revocation is always explicit and audited. */
    async change(
      context: TenantContext,
      id: string,
      command: SourceEnvironmentCommand,
    ) {
      const current = await fresh(context, true);
      await enabled(current.tenantId);
      if (
        !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(
          command.commandId,
        ) ||
        !Number.isInteger(command.expectedRevision) ||
        command.expectedRevision < 0 ||
        !command.reason.trim() ||
        command.reason.length > 1000 ||
        command.liveOperationsConfirmed !== (command.reviewId !== null)
      )
        throw new IdentityError(
          422,
          'VALIDATION_ERROR',
          'Confirm operational use with a review and reason, or revoke it',
        );
      const review = command.reviewId
        ? await deps.repository.review(current.tenantId, command.reviewId)
        : null;

      return deps.repository.change(
        current,
        id,
        command,
        deps.fingerprint({ actorId: current.actor.id, id, ...command }),
        async (previous, c) => {
          if (
            command.reviewId &&
            (!review ||
              review.connectionId !== id ||
              review.actorId !== current.actor.id ||
              Date.parse(review.expiresAt) <= deps.now().getTime() ||
              !(await reviewability(current, c)).reviewable ||
              review.sourceBinding !== deps.binding(c))
          )
            throw new IdentityError(
              409,
              'CONFLICT',
              'Reviewed source changed or expired; inspect again',
            );

          return {
            connectionId: id,
            revision: (previous?.revision ?? 0) + 1,
            review,
            revoked: !command.reviewId,
            actorId: current.actor.id,
            reason: command.reason.trim(),
            at: deps.now().toISOString(),
          };
        },
      );
    },
  };
}

export type SourceEnvironments = ReturnType<typeof createSourceEnvironments>;
