import type { TenantContext } from '@luma/identity';
import { hasPermission, IdentityError, requireTenant } from '@luma/identity';

export interface DecisionAssignment {
  assigneeId: string | null;
  assignedBy: string;
  assignedAt: string;
  revision: number;
}

export interface DecisionAssignmentStore {
  get(tenantId: string, decisionId: string): Promise<DecisionAssignment | null>;
  /**
   * Replaces the assignment when its revision still equals `expected` (0 when none exists).
   * Returns null when another change won.
   */
  save(
    tenantId: string,
    decisionId: string,
    expected: number,
    next: Omit<DecisionAssignment, 'revision'>,
  ): Promise<DecisionAssignment | null>;
}

/**
 * Creates assignment commands for Needs you decisions. People with `decisions.self_assign` may
 * take an unassigned decision or release their own; people with `decisions.assign` may assign
 * any decision to a current member. Others are rejected with 403. Assignment never grants
 * approval authority; the decision's owner checks permissions again.
 */
export function createDecisionAssignmentService(deps: {
  store: DecisionAssignmentStore;
  refreshContext(context: TenantContext): Promise<TenantContext>;
  /** Lists the user IDs of current workspace members. */
  members(context: TenantContext): Promise<string[]>;
  /** Whether the decision currently needs a person, under the reader's permissions. */
  pending(context: TenantContext, decisionId: string): Promise<boolean>;
  now(): Date;
}) {
  return {
    async assign(
      context: TenantContext,
      input: {
        decisionId: string;
        assigneeId: string | null;
        revision: number;
      },
    ) {
      const fresh = await deps.refreshContext(context);
      requireTenant(fresh, context.tenantId);
      if (fresh.actor.id !== context.actor.id)
        throw new IdentityError(403, 'FORBIDDEN', 'Sign in again to continue.');
      const assignsAnyone = hasPermission(fresh, 'decisions.assign');
      if (!assignsAnyone && !hasPermission(fresh, 'decisions.self_assign'))
        throw new IdentityError(
          403,
          'FORBIDDEN',
          'Your role cannot take or assign decisions.',
        );
      if (!(await deps.pending(fresh, input.decisionId)))
        throw new IdentityError(
          404,
          'NOT_FOUND',
          'This decision no longer needs a person.',
        );
      const current = await deps.store.get(fresh.tenantId, input.decisionId);
      if ((current?.revision ?? 0) !== input.revision)
        throw new IdentityError(
          409,
          'CONFLICT',
          'Someone changed this assignment. Refresh to see who has it.',
        );
      const holder = current?.assigneeId ?? null;
      if (!assignsAnyone) {
        const taking =
          input.assigneeId === fresh.actor.id &&
          (holder === null || holder === fresh.actor.id);
        const releasing =
          input.assigneeId === null && holder === fresh.actor.id;
        if (!taking && !releasing)
          throw new IdentityError(
            403,
            'FORBIDDEN',
            'You can take unassigned decisions or release your own. Ask someone who assigns decisions to reassign it.',
          );
      }
      if (
        input.assigneeId !== null &&
        !(await deps.members(fresh)).includes(input.assigneeId)
      )
        throw new IdentityError(
          409,
          'CONFLICT',
          'Choose a current member of this workspace.',
        );
      const saved = await deps.store.save(
        fresh.tenantId,
        input.decisionId,
        input.revision,
        {
          assigneeId: input.assigneeId,
          assignedBy: fresh.actor.id,
          assignedAt: deps.now().toISOString(),
        },
      );
      if (!saved)
        throw new IdentityError(
          409,
          'CONFLICT',
          'Someone changed this assignment. Refresh to see who has it.',
        );

      return { decisionId: input.decisionId, assignment: saved };
    },
  };
}
