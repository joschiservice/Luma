import type { Permission, TenantContext } from '@luma/identity';
import { describe, expect, it, vi } from 'vitest';

import type {
  DecisionAssignment,
  DecisionAssignmentStore,
} from './decision-assignments.js';
import { createDecisionAssignmentService } from './decision-assignments.js';
import { testContext } from './tenant-context.fixture.js';

function service(fresh: TenantContext, holder: string | null) {
  const current: DecisionAssignment | null = holder
    ? {
        assigneeId: holder,
        assignedBy: holder,
        assignedAt: '2026-10-06T10:00:00.000Z',
        revision: 1,
      }
    : null;
  const store: DecisionAssignmentStore = {
    get: async () => current,
    save: vi.fn(async (_tenant, _decision, expected, next) => ({
      ...next,
      revision: expected + 1,
    })),
  };

  return {
    store,
    assignments: createDecisionAssignmentService({
      store,
      refreshContext: async () => fresh,
      members: async () => ['operator', 'colleague'],
      pending: async () => true,
      now: () => new Date('2026-10-06T12:00:00Z'),
    }),
  };
}

const as = (permissions: Permission[]) =>
  testContext({ userId: 'operator', permissions });

describe('Decision assignment permissions', () => {
  it.each([
    ['takes an unassigned decision', null, 'operator'],
    ['releases their own decision', 'operator', null],
  ] as const)(
    'lets self-assigners do what they may: %s',
    async (_case, holder, assigneeId) => {
      const context = as(['decisions.self_assign']);
      const { assignments, store } = service(context, holder);

      await expect(
        assignments.assign(context, {
          decisionId: 'decision',
          assigneeId,
          revision: holder ? 1 : 0,
        }),
      ).resolves.toMatchObject({ assignment: { assigneeId } });
      expect(store.save).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ['assign a colleague', null, 'colleague'],
    ['take a colleague’s decision', 'colleague', 'operator'],
    ['release a colleague’s decision', 'colleague', null],
  ] as const)(
    'stops self-assigners who %s',
    async (_case, holder, assigneeId) => {
      const context = as(['decisions.self_assign']);
      const { assignments, store } = service(context, holder);

      await expect(
        assignments.assign(context, {
          decisionId: 'decision',
          assigneeId,
          revision: holder ? 1 : 0,
        }),
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(store.save).not.toHaveBeenCalled();
    },
  );

  it('lets assigners reassign a colleague’s decision', async () => {
    const context = as(['decisions.assign']);
    const { assignments } = service(context, 'colleague');

    await expect(
      assignments.assign(context, {
        decisionId: 'decision',
        assigneeId: 'operator',
        revision: 1,
      }),
    ).resolves.toMatchObject({ assignment: { assigneeId: 'operator' } });
  });

  it('rejects people who can neither take nor assign decisions', async () => {
    const context = as(['issues.read']);
    const { assignments, store } = service(context, null);

    await expect(
      assignments.assign(context, {
        decisionId: 'decision',
        assigneeId: 'operator',
        revision: 0,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(store.save).not.toHaveBeenCalled();
  });
});
