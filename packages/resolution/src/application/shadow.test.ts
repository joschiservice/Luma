import { describe, expect, it, vi } from 'vitest';

import { createExceptionActivities } from './runtime.js';
import type { ShadowStore } from './shadow.js';
import { createShadowService } from './shadow.js';
import { testContext } from './tenant-context.fixture.js';

const context = testContext({ tenantId: 'tenant' });

describe('Shadow safety boundaries', () => {
  it.each(['execute', 'reconcile', 'verify', 'propose', 'refresh'] as const)(
    'rejects %s before touching live services',
    async (method) => {
      const live = new Proxy(
        {},
        {
          get: () => {
            throw new Error('Live service accessed');
          },
        },
      );
      const activities = createExceptionActivities({
        identity: live,
        exceptions: live,
        diagnoses: live,
        execution: live,
        bindings: live,
      } as Parameters<typeof createExceptionActivities>[0]);
      const input = {
        tenantId: 'tenant',
        userId: 'owner',
        requestId: 'request',
        source: { kind: 'incident' as const, id: 'incident' },
        shadow: { id: 'evaluation', workflow: 'shipping' },
      };
      const call =
        method === 'execute'
          ? activities.execute(input, 'incident', {
              id: 'proposal',
              revision: 1,
              expiresAt: '',
            })
          : method === 'propose'
            ? activities.propose(input, 'incident', 1)
            : method === 'refresh'
              ? activities.refresh!(input, 'incident')
              : method === 'verify'
                ? activities.verify(input, 'incident')
                : activities.reconcile(input, 'proposal');
      await expect(call).rejects.toThrow('Shadow');
    },
  );
  it.each(['member', 'tenant', 'actor'] as const)(
    'refreshes and rejects changed %s authority before storage',
    async (change) => {
      const store = {
        evaluate: vi.fn(),
        list: vi.fn(),
        review: vi.fn(),
      } satisfies ShadowStore;
      const fresh = testContext({
        tenantId: change === 'tenant' ? 'other' : 'tenant',
        role: change === 'member' ? 'member' : 'owner',
        userId: change === 'actor' ? 'other' : 'owner',
      });
      const service = createShadowService({
        store,
        refreshContext: async () => fresh,
        parseRequest: (x) => x as never,
        parseReview: (x) => x as never,
        parseWindow: (x) => x as never,
        parseId: (x) => x,
        sameAction: () => false,
        now: () => new Date(),
      });
      await expect(service.evaluate(context, 'incident', {})).rejects.toThrow();
      expect(store.evaluate).not.toHaveBeenCalled();
    },
  );
});
