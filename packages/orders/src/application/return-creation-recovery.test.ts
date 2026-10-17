import { builtInMembership, makeTenantContext } from '@luma/identity';
import { describe, expect, it } from 'vitest';

import type { ReturnCase } from '../domain/return-cases.js';
import type { ReturnCreation } from '../domain/return-creations.js';
import {
  createReturnCases,
  type CreationAdmission,
  type CreationExecution,
  type ReturnCaseEvent,
  type ReturnCaseTransaction,
} from './return-cases.js';

const now = new Date('2026-10-12T12:00:00Z');
const later = (ms: number) => new Date(now.getTime() - ms).toISOString();
const context = makeTenantContext(
  { userId: 'requester', sessionId: 'session' },
  {
    id: 'tenant',
    name: 'Fixture',
    slug: 'fixture',
    dataRegion: 'EU',
    status: 'active',
  },
  builtInMembership(
    { id: 'member', organizationId: 'tenant', userId: 'requester' },
    'owner',
  ),
  'creation-recovery-test',
);
const unused = async (): Promise<never> => {
  throw new Error('Not used by the background pass');
};
const ref = (externalId: string) => ({ externalId, scopeKey: '' });

function fixture() {
  const value: ReturnCase = {
    id: 'case',
    tenantId: 'tenant',
    orderId: 'order',
    connectionId: 'shopify',
    sourceReturnId: null,
    state: 'open',
    lines: [
      {
        orderLineId: 'line',
        quantity: 1,
        reason: 'other',
        note: null,
        sku: null,
        title: null,
      },
    ],
    assigneeId: null,
    receipt: null,
    inspection: null,
    proposal: null,
    revision: 1,
    openedBy: 'requester',
    openedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    cancellation: null,
  };
  let creation: ReturnCreation = {
    id: 'creation',
    tenantId: 'tenant',
    caseId: 'case',
    connectionId: 'shopify',
    order: ref('order'),
    warehouse: { ...ref('warehouse'), name: null },
    reason: { ...ref('reason'), name: null },
    lines: [{ orderLineId: 'line', source: ref('line'), quantity: 1 }],
    actionId: 'action',
    decisionId: 'decision',
    requestedBy: 'requester',
    requestedAt: later(60 * 60_000),
    expiresAt: '2026-10-13T11:00:00Z',
    state: 'approved',
    externalReturn: null,
    createdAt: null,
    decidedBy: 'approver',
    decidedAt: later(60 * 60_000),
    failure: null,
    updatedAt: later(60 * 60_000),
  };
  const events: ReturnCaseEvent[] = [];
  let executions = 0;
  let reserved = false;
  let approval: {
    outcome: 'approved' | 'rejected';
    approverId: string;
  } | null = null;
  const tx = {
    case: async () => structuredClone(value),
    creation: async () => structuredClone(creation),
    saveCreation: async (next: ReturnCreation) => {
      creation = structuredClone(next);
    },
    liveCreations: async () => [structuredClone(creation)],
    event: async (commandId: string) =>
      events.find((e) => e.commandId === commandId) ?? null,
    insertEvent: async (event: ReturnCaseEvent) => {
      events.push(event);
    },
    audit: async () => {},
  } as Partial<ReturnCaseTransaction>;
  const store = {
    transaction: async <T>(
      _tenant: string,
      _write: boolean,
      operation: (tx: ReturnCaseTransaction) => Promise<T>,
    ) =>
      operation(
        new Proxy(tx, {
          get: (target, key: keyof ReturnCaseTransaction) =>
            target[key] ?? unused,
        }) as ReturnCaseTransaction,
      ),
  };
  const verified: CreationExecution = { state: 'verified' };
  const admission: CreationAdmission = {
    prepare: unused,
    respond: unused,
    decision: async () =>
      approval
        ? ({ approval } as unknown as Awaited<
            ReturnType<CreationAdmission['decision']>
          >)
        : null,
    execute: async () => {
      executions++;
      reserved = true;

      return verified;
    },
    reconcile: async () => (reserved ? verified : { state: 'not_started' }),
    get: async () => (reserved ? verified : { state: 'not_started' }),
  };
  const service = createReturnCases({
    store,
    admission,
    system: {
      connections: unused,
      options: unused,
      created: async () => ({
        ok: true,
        value: {
          complete: true,
          items: [
            {
              observationId: 'observation',
              observedAt: now.toISOString(),
              externalId: 'return',
              number: 'R1',
              lines: [{ orderLine: ref('line'), quantity: '1' }],
            },
          ],
        },
      }),
    },
    refreshContext: async (c) => c,
    principal: unused,
    digest: (v) => JSON.stringify(v) ?? 'undefined',
    uuid: (name) => name,
    now: () => now,
  });

  return {
    recover: () => service.recover(context),
    current: () => creation,
    events,
    executions: () => executions,
    patch: (next: Partial<ReturnCreation>) => {
      creation = { ...creation, ...next };
    },
    reserve: () => {
      reserved = true;
    },
    setApproval: (next: typeof approval) => {
      approval = next;
    },
  };
}

describe('return creation background follow-up', () => {
  it('sends an approved creation as its requester once and records it after a fresh read', async () => {
    const f = fixture();
    await f.recover();
    expect(f.current()).toMatchObject({
      state: 'created',
      externalReturn: { externalId: 'return', number: 'R1' },
    });
    await f.recover();
    expect(f.executions()).toBe(1);
  });

  it('expires an approved creation that was never sent once its approval ended', async () => {
    const f = fixture();
    f.patch({ expiresAt: later(1) });
    await f.recover();
    expect(f.current().state).toBe('expired');
    expect(f.executions()).toBe(0);
  });

  it('settles an uncertain creation by reading, without sending again', async () => {
    const f = fixture();
    f.reserve();
    f.patch({ state: 'uncertain', updatedAt: later(60_000) });
    await f.recover();
    expect(f.current().state).toBe('created');
    expect(f.executions()).toBe(0);
  });

  it('settles a reserved creation by reading even after its approval ended', async () => {
    const f = fixture();
    f.reserve();
    f.patch({
      state: 'sending',
      expiresAt: later(1),
      updatedAt: later(2 * 60_000),
    });
    await f.recover();
    expect(f.current().state).toBe('created');
    expect(f.executions()).toBe(0);
  });

  it('resumes a send the execution ledger never reserved', async () => {
    const f = fixture();
    f.patch({ state: 'uncertain', updatedAt: later(60_000) });
    await f.recover();
    expect(f.current().state).toBe('created');
    expect(f.executions()).toBe(1);
  });

  it('applies an approval recorded by policy, attributed to the approver, then sends', async () => {
    const f = fixture();
    f.patch({ state: 'approval_required', decidedBy: null, decidedAt: null });
    await f.recover();
    expect(f.current().state).toBe('approval_required');
    f.setApproval({ outcome: 'approved', approverId: 'approver' });
    await f.recover();
    expect(f.current()).toMatchObject({
      state: 'created',
      decidedBy: 'approver',
    });
    expect(f.events.find((e) => e.kind === 'creation_approved')?.actorId).toBe(
      'approver',
    );
    expect(f.executions()).toBe(1);
  });
});
