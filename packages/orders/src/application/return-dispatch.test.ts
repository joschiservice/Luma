import { builtInMembership, makeTenantContext } from '@luma/identity';
import { describe, expect, it } from 'vitest';

import type { ReturnAction } from '../domain/return-actions.js';
import type { ReturnCase } from '../domain/return-cases.js';
import type {
  ExchangeStep,
  ReturnExchange,
} from '../domain/return-exchanges.js';
import {
  createReturnActions,
  type ReturnActionStore,
  type ReturnSettlementAdmission,
} from './return-actions.js';
import {
  createReturnExchanges,
  type ReturnExchangeStore,
} from './return-exchanges.js';

const now = new Date('2026-10-12T12:00:00Z');
const context = makeTenantContext(
  { userId: 'owner', sessionId: 'session' },
  {
    id: 'tenant',
    name: 'Fixture',
    slug: 'fixture',
    dataRegion: 'EU',
    status: 'active',
  },
  builtInMembership(
    { id: 'member', organizationId: 'tenant', userId: 'owner' },
    'owner',
  ),
  'dispatch-test',
);
const unavailable = async (): Promise<never> => {
  throw new Error('Not used by this journey');
};
const ref = (externalId: string) => ({ externalId, scopeKey: '' });
const decided = {
  by: 'owner',
  at: now.toISOString(),
  evidence: { note: 'Counted', link: null },
};

function fixture(kind: 'settlement' | 'exchange') {
  const c: ReturnCase = {
    id: 'case',
    tenantId: 'tenant',
    orderId: 'order',
    connectionId: 'shopify',
    sourceReturnId: null,
    state: 'open',
    lines: [
      {
        orderLineId: 'line',
        quantity: 2,
        reason: 'other',
        note: null,
        sku: null,
        title: null,
      },
    ],
    assigneeId: null,
    receipt: { ...decided, lines: [{ orderLineId: 'line', received: 2 }] },
    inspection: {
      ...decided,
      lines: [{ orderLineId: 'line', resellable: 2, damaged: 0 }],
    },
    proposal: {
      ...decided,
      kind: kind === 'exchange' ? 'exchange' : 'refund',
      lines: [{ orderLineId: 'line', restock: 2 }],
    },
    revision: 4,
    openedBy: 'owner',
    openedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    cancellation: null,
  };
  const replacement = {
    skuId: 'sku',
    mappingIds: ['shop', 'wawi'],
    inventoryItem: ref('item'),
    variantId: 'variant',
    wawiConnectionId: 'wawi',
    item: ref('item'),
    quantity: 2,
  };
  let root: ReturnExchange = {
    id: 'operation',
    tenantId: 'tenant',
    caseId: 'case',
    connectionId: 'shopify',
    startedBy: 'owner',
    startedAt: now.toISOString(),
    ownerId: 'owner',
    revision: 1,
    choice: null,
    currentAttemptId: 'request',
    replacementName: 'Replacement',
    request: {
      kind: 'request',
      marker: 'marker',
      order: ref('order'),
      lines: [
        {
          orderLineId: 'line',
          source: ref('line'),
          quantity: 2,
          reason: 'OTHER',
        },
      ],
      replacement,
    },
    availability: null,
    processingStarted: false,
    updatedAt: now.toISOString(),
  };
  const base = {
    id: 'effect',
    actionId: 'action',
    tenantId: 'tenant',
    caseId: 'case',
    connectionId: 'shopify',
    caseDigest: 'facts',
    requestDigest: 'request',
    quote: { observedAt: now.toISOString(), evidenceRefs: ['quote'] },
    requestedBy: 'owner',
    requestedAt: now.toISOString(),
    expiresAt: '2026-10-13T12:00:00Z',
    decisionId: 'decision',
    decidedBy: 'approver',
    decidedAt: now.toISOString(),
    state: 'approved' as const,
    sent: false,
    proof: null,
    failure: null,
    updatedAt: now.toISOString(),
  };
  let action: ReturnAction = {
    ...base,
    kind: 'restock',
    orderLineId: 'line',
    mappingIds: ['map'],
    plan: {
      kind: 'restock',
      item: ref('item'),
      warehouse: ref('warehouse'),
      quantity: 2,
      baselineOnHand: '10',
    },
  };
  let step: ExchangeStep = {
    ...base,
    operationId: 'operation',
    plan: {
      kind: 'process',
      marker: 'marker',
      order: ref('order'),
      returnId: 'return',
      returnLines: [{ id: 'return-line', quantity: 2 }],
      exchangeLine: { id: 'exchange-line', quantity: 2 },
      replacement,
      financial: {
        kind: 'even',
        amount: '0',
        currency: 'EUR',
        transactions: [],
        priorSuccessfulTransactionIds: [],
      },
    },
  };
  const actionStore: ReturnActionStore = {
    transaction: async (_tenant, fn) =>
      fn({
        lock: async () => structuredClone(c),
        get: async () => structuredClone(action),
        save: async (v) => {
          action = structuredClone(v);
        },
        list: async () => [structuredClone(action)],
        live: async () => [structuredClone(action)],
        insert: unavailable,
        targets: async () => [],
        audit: async () => {},
      }),
  };
  const exchangeStore: ReturnExchangeStore = {
    transaction: async (_tenant, fn) =>
      fn({
        lock: async () => structuredClone(c),
        root: async () => structuredClone(root),
        saveRoot: async (v) => {
          root = structuredClone(v);
        },
        get: async () => structuredClone(step),
        save: async (v) => {
          step = structuredClone(v);
        },
        list: async () => [structuredClone(step)],
        live: async () => [structuredClone(step)],
        insert: unavailable,
        choices: async () => [],
        refundFallback: unavailable,
        stockActions: async () => [],
        finishCase: unavailable,
        audit: async () => {},
      }),
  };
  let execute = async (): Promise<{
    state: 'uncertain' | 'withheld' | 'not_started';
    failure: 'withheld';
  }> => ({ state: 'uncertain', failure: 'withheld' });
  let executions = 0;
  let ledger: 'not_started' | 'uncertain' = 'not_started';
  let approval: {
    outcome: 'approved' | 'rejected';
    approverId: string;
  } | null = null;
  const admission = {
    prepare: unavailable,
    decision: async () =>
      approval
        ? ({ approval } as unknown as Awaited<
            ReturnType<ReturnSettlementAdmission['decision']>
          >)
        : null,
    respond: async () => {},
    execute: () => {
      executions++;

      return execute();
    },
    reconcile: async () => ({ state: 'uncertain' as const }),
    get: async () => ({ state: ledger }),
    writeMode: async () => 'writes_enabled' as const,
  };
  const common = {
    cases: { transaction: unavailable },
    digest: (v: unknown) =>
      v === c || (Array.isArray(v) && v[0] === 'open')
        ? 'facts'
        : (JSON.stringify(v) ?? 'undefined'),
    uuid: (s: string) => s,
    now: () => now,
    refreshContext: async () => context,
    principal: async () => context,
    admission,
  };
  let outcome: 'passed' | 'inconclusive' = 'passed';
  const service =
    kind === 'settlement'
      ? createReturnActions({
          ...common,
          store: actionStore,
          system: {
            warehouses: unavailable,
            quote: unavailable,
            proof: async () => ({
              outcome,
              payment: null,
              observedAt: now.toISOString(),
              evidenceRefs: ['source-proof'],
            }),
          },
        })
      : createReturnExchanges({
          ...common,
          store: exchangeStore,
          system: {
            choices: unavailable,
            quote: unavailable,
            availability: async () => ({
              available: true,
              observedAt: now.toISOString(),
              evidenceRefs: ['stock'],
            }),
            proof: async () => ({
              outcome,
              observedAt: now.toISOString(),
              evidenceRefs: ['source-proof'],
              returnId: 'return',
              processLines: null,
              fulfillmentOrderId: 'fulfillment',
              paymentHoldId: null,
              fulfillmentReady: true,
              payment: 'not_required',
              financial: null,
            }),
          },
        });

  return {
    send: () => service.send(context, 'case', 'effect'),
    recover: () => service.recover(context),
    executions: () => executions,
    setLedger: (next: typeof ledger) => {
      ledger = next;
    },
    setApproval: (next: typeof approval) => {
      approval = next;
    },
    patch: (next: Partial<ReturnAction & ExchangeStep>) => {
      if (kind === 'settlement')
        action = { ...action, ...next } as ReturnAction;
      else step = { ...step, ...next } as ExchangeStep;
    },
    check: () => service.check(context, 'case', 'effect'),
    setOutcome: (next: typeof outcome) => {
      outcome = next;
    },
    setExecute: (fn: typeof execute) => {
      execute = fn;
    },
    current: () => (kind === 'settlement' ? action : step),
    root: () => root,
  };
}

describe.each(['settlement', 'exchange'] as const)(
  '%s dispatch fencing',
  (kind) => {
    it('keeps a proved effect when a concurrent sender returns withheld late', async () => {
      const f = fixture(kind);
      let release!: () => void,
        entered!: () => void,
        calls = 0;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const started = new Promise<void>((r) => {
        entered = r;
      });
      f.setExecute(async () => {
        if (++calls === 1) {
          entered();
          await gate;

          return { state: 'withheld', failure: 'withheld' };
        }

        return { state: 'uncertain', failure: 'withheld' };
      });
      const slow = f.send();
      await started;
      await f.send();
      expect(f.current()).toMatchObject({ sent: true, state: 'verified' });
      release();
      await slow;
      expect(f.current()).toMatchObject({
        sent: true,
        state: 'verified',
        proof: { outcome: 'passed' },
      });
      if (kind === 'exchange') expect(f.root().processingStarted).toBe(true);
    });
    it('preserves a resumable identity when admission has not reserved execution yet', async () => {
      const f = fixture(kind);
      f.setExecute(async () => ({ state: 'not_started', failure: 'withheld' }));
      expect(await f.send()).toMatchObject({
        sent: true,
        state: 'sending',
        proof: null,
      });
      f.setExecute(async () => ({ state: 'uncertain', failure: 'withheld' }));
      expect(await f.send()).toMatchObject({ sent: true, state: 'verified' });
    });
    it('releases confirmed non-dispatch even if a concurrent check observed only inconclusive evidence', async () => {
      const f = fixture(kind);
      f.setOutcome('inconclusive');
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const started = new Promise<void>((r) => {
        entered = r;
      });
      f.setExecute(async () => {
        entered();
        await gate;

        return { state: 'withheld', failure: 'withheld' };
      });
      const send = f.send();
      await started;
      await f.check();
      expect(f.current().proof?.outcome).toBe('inconclusive');
      release();
      await send;
      expect(f.current()).toMatchObject({ sent: false, state: 'not_executed' });
      if (kind === 'exchange') expect(f.root().processingStarted).toBe(false);
    });

    it('releases only a still-sending identity after confirmed non-dispatch', async () => {
      const f = fixture(kind);
      f.setExecute(async () => ({ state: 'withheld', failure: 'withheld' }));
      expect(await f.send()).toMatchObject({
        sent: false,
        state: 'not_executed',
      });
      if (kind === 'exchange') expect(f.root().processingStarted).toBe(false);
    });
  },
);

describe.each(['settlement', 'exchange'] as const)(
  '%s background follow-up',
  (kind) => {
    const later = (ms: number) => new Date(now.getTime() - ms).toISOString();

    it('sends an approved write as its requester once and verifies it by reading', async () => {
      const f = fixture(kind);
      await f.recover();
      expect(f.current()).toMatchObject({
        sent: true,
        state: 'verified',
        proof: { outcome: 'passed' },
      });
      await f.recover();
      expect(f.executions()).toBe(1);
    });

    it('records an expired approval without sending', async () => {
      const f = fixture(kind);
      f.patch({ expiresAt: later(1) });
      await f.recover();
      expect(f.current()).toMatchObject({ sent: false, state: 'expired' });
      expect(f.executions()).toBe(0);
    });

    it('applies an approval policy recorded but the owner never stored, then sends', async () => {
      const f = fixture(kind);
      f.patch({ state: 'approval_required', decidedBy: null, decidedAt: null });
      await f.recover();
      expect(f.current().state).toBe('approval_required');
      f.setApproval({ outcome: 'approved', approverId: 'approver' });
      await f.recover();
      expect(f.current()).toMatchObject({
        decidedBy: 'approver',
        sent: true,
        state: 'verified',
      });
      expect(f.executions()).toBe(1);
    });

    it('reads a reserved uncertain write and never sends it again', async () => {
      const f = fixture(kind);
      f.patch({ sent: true, state: 'uncertain', updatedAt: later(60_000) });
      f.setLedger('uncertain');
      await f.recover();
      expect(f.current()).toMatchObject({ sent: true, state: 'verified' });
      expect(f.executions()).toBe(0);
    });

    it('resumes a fenced send the ledger never reserved, within its approval', async () => {
      const f = fixture(kind);
      f.patch({ sent: true, state: 'sending', updatedAt: later(2 * 60_000) });
      await f.recover();
      expect(f.current()).toMatchObject({ sent: true, state: 'verified' });
      expect(f.executions()).toBe(1);
    });

    it('releases a fenced send the ledger never reserved once its approval ended', async () => {
      const f = fixture(kind);
      f.patch({
        sent: true,
        state: 'uncertain',
        expiresAt: later(1),
        updatedAt: later(60_000),
      });
      await f.recover();
      expect(f.current()).toMatchObject({ sent: false, state: 'expired' });
      expect(f.executions()).toBe(0);
    });

    it('leaves a recent send to the request dispatching it', async () => {
      const f = fixture(kind);
      f.patch({ sent: true, state: 'sending' });
      await f.recover();
      expect(f.current()).toMatchObject({ sent: true, state: 'sending' });
      expect(f.executions()).toBe(0);
    });
  },
);
