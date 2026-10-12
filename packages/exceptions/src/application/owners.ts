import type { TenantContext } from '@luma/identity';
import {
  IdentityError,
  requireChangesAllowed,
  requirePermission,
  requireTenant,
} from '@luma/identity';

/** Current case responsibility; assignment never grants decision or execution permissions. */
export interface CaseOwner {
  userId: string | null;
  name: string | null;
  revision: number;
  assignedBy: string;
  assignedAt: string;
}

/** Persists an optimistic ownership revision and its audit record atomically. */
export interface CaseOwnerStore {
  assign(
    context: TenantContext,
    id: string,
    input: { userId: string | null; revision: number },
  ): Promise<CaseOwner>;
}

/** Assigns, reassigns or clears case responsibility using refreshed membership and current people. */
export function createCaseOwners(deps: {
  store: CaseOwnerStore;
  refreshContext(context: TenantContext): Promise<TenantContext>;
  members(context: TenantContext): Promise<
    {
      userId: string;
      status?: string | undefined;
      accountDisabled?: boolean | undefined;
    }[]
  >;
}) {
  return {
    async assign(
      context: TenantContext,
      id: string,
      input: { userId: string | null; revision: number },
    ) {
      const fresh = await deps.refreshContext(context);
      requireTenant(fresh, context.tenantId);
      requirePermission(fresh, 'decisions.assign');
      requireChangesAllowed(fresh);
      if (fresh.actor.id !== context.actor.id)
        throw new IdentityError(403, 'FORBIDDEN', 'Sign in again to continue.');
      if (
        input.userId &&
        !(await deps.members(fresh)).some(
          (member) =>
            member.userId === input.userId &&
            member.status !== 'suspended' &&
            !member.accountDisabled,
        )
      )
        throw new IdentityError(
          422,
          'VALIDATION_ERROR',
          'Choose an active workspace member.',
        );

      return deps.store.assign(fresh, id, input);
    },
  };
}

/** Audit port supplied by runtime composition; case ownership never writes audit tables itself. */
export interface CaseOwnerAudit {
  id: string;
  tenantId: string;
  eventKey: string;
  eventType: string;
  schemaVersion: 1;
  occurredAt: string;
  actor: { kind: 'user'; id: string };
  correlationId: string;
  proposalId: string;
  actionHash: string;
  evidenceRefs: string[];
  details: Record<string, string>;
}
