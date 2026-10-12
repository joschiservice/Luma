import type { TenantContext } from '@luma/identity';
import type { ProcessWorkflowVersion } from '@luma/workflows';
import { expect, it } from 'vitest';

import {
  createReturnStepFollowUp,
  type ReturnStepWait,
} from './return-step-follow-up.js';

it('retains an owned handover when provider proof is absent and retires only verified progress', async () => {
  const at = '2026-10-11T12:00:00.000Z';
  let wait: ReturnStepWait = {
    id: 'wait',
    caseId: 'case',
    orderId: 'order',
    connectionId: 'connection',
    phase: 'financial',
    reason: 'unavailable_evidence',
    state: 'escalated',
    dueAt: at,
    openedAt: at,
    updatedAt: at,
    observedAt: null,
    evidenceRefs: [],
  };
  const adapter = createReturnStepFollowUp({
    version: {} as ProcessWorkflowVersion,
    configured: async () => true,
    tick: async () => {},
    pending: async () => [wait],
    get: async () => wait,
    now: () => new Date(at),
  });
  const context = {} as TenantContext;
  const run = { signal: { id: 'wait' } } as never;
  expect(await adapter.read(context, run, {} as never)).toEqual({
    values: { ready: true, waiting: true },
    evidenceRefs: ['return-wait:wait'],
    observedAt: at,
  });
  expect((await adapter.signals!.open(context))[0]?.open).toBe(true);
  wait = { ...wait, state: 'paused' };
  expect((await adapter.read(context, run, {} as never)).values.waiting).toBe(
    true,
  );
  wait = {
    ...wait,
    state: 'verified',
    observedAt: at,
    evidenceRefs: ['native-refund'],
  };
  expect((await adapter.read(context, run, {} as never)).values.waiting).toBe(
    false,
  );
  expect((await adapter.signals!.get(context, 'wait'))?.open).toBe(false);
  await expect(
    adapter.action(context, run, {} as never, {} as never),
  ).rejects.toThrow('changes nothing');
});
