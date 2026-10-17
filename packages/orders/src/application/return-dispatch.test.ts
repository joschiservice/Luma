import type { WriteAcceptance } from '@luma/connections';
import { builtInMembership, makeTenantContext } from '@luma/identity';
import { describe, expect, it } from 'vitest';

import type { ReturnAction } from '../domain/return-actions.js';
import type { ReturnCase } from '../domain/return-cases.js';
import type {
  ExchangeStep,
  ReturnExchange,
} from '../domain/return-exchanges.js';
import type { ReturnRead, ReturnReadEvidence } from '../domain/return-reads.js';
import {
  createReturnActions,
  type ReturnActionStore,
  type ReturnSettlementAdmission,
} from './return-actions.js';
import {
  createReturnExchanges,
  type ReturnExchangeStore,
} from './return-exchanges.js';
import type { ReturnWriteReceipt } from './return-write-receipts.js';

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
const read = (
  id: string,
  completeness: ReturnRead['completeness'] = 'complete',
): ReturnRead => ({
  id,
  source: {
    provider: 'shopify',
    connectionId: 'shopify',
    resource: 'order',
    externalId: 'order',
    scopeKey: '',
  },
  observedAt: now.toISOString(),
  sourceUpdatedAt: null,
  sourceRevision: 'r1',
  adapterVersion: 'shopify-returns/1',
  completeness,
  data: { operationId: 'effect' },
});

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
  const stored: ReturnReadEvidence[] = [];
  let storage: 'ok' | 'failing' = 'ok';
  const recordRead = async (evidence: ReturnReadEvidence) => {
    if (storage === 'failing') throw new Error('storage unavailable');
    if (!stored.some((s) => s.id === evidence.id)) stored.push(evidence);
  };
  const receipts: ReturnWriteReceipt[] = [];
  const recordWriteReceipt = async (receipt: ReturnWriteReceipt) => {
    if (storage === 'failing') throw new Error('storage unavailable');
    if (!receipts.some((r) => r.id === receipt.id)) receipts.push(receipt);
  };
  const reads = { locks: 0, snapshots: 0 };
  const actionStore: ReturnActionStore = {
    transaction: async (_tenant, fn, options) => {
      if (options?.readOnlySnapshot) reads.snapshots++;

      return fn({
        lock: async () => {
          reads.locks++;

          return structuredClone(c);
        },
        read: async () => structuredClone(c),
        get: async () => structuredClone(action),
        save: async (v) => {
          action = structuredClone(v);
        },
        list: async () => [structuredClone(action)],
        live: async () => [structuredClone(action)],
        insert: unavailable,
        targets: async () => [],
        audit: async () => {},
        recordRead,
        recordWriteReceipt,
      });
    },
  };
  const exchangeStore: ReturnExchangeStore = {
    transaction: async (_tenant, fn, options) => {
      if (options?.readOnlySnapshot) reads.snapshots++;

      return fn({
        lock: async () => {
          reads.locks++;

          return structuredClone(c);
        },
        read: async () => structuredClone(c),
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
        recordRead,
        recordWriteReceipt,
      });
    },
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
  let proofReads: ReturnRead[] = [read('source-proof')];
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
              reads: proofReads,
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
              reads: [read('stock')],
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
              reads: proofReads,
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
    list: () => service.list(context, 'case'),
    reads,
    setOutcome: (next: typeof outcome) => {
      outcome = next;
    },
    setExecute: (fn: typeof execute) => {
      execute = fn;
    },
    current: () => (kind === 'settlement' ? action : step),
    root: () => root,
    verify: () => service.verify(context, 'effect'),
    storeReceipt: (acceptance: WriteAcceptance) =>
      service.storeWriteReceipt(context, 'effect', acceptance),
    stored,
    receipts,
    setStorage: (next: typeof storage) => {
      storage = next;
    },
    setProofReads: (next: ReturnRead[]) => {
      proofReads = next;
    },
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

    it('reads case detail from one snapshot without taking the case write lock', async () => {
      const f = fixture(kind);
      await f.list();
      expect(f.reads).toEqual({ locks: 0, snapshots: 1 });
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

describe.each(['settlement', 'exchange'] as const)(
  '%s verification evidence',
  (kind) => {
    const purpose = kind === 'settlement' ? 'settlement' : 'exchange';

    it('stores every cited read with its source identity before citing it', async () => {
      const f = fixture(kind);
      f.patch({ sent: true, state: 'uncertain' });
      expect(await f.verify()).toEqual({
        outcome: 'passed',
        observationRefs: ['source-proof'],
      });
      expect(f.stored).toEqual([
        {
          ...read('source-proof'),
          tenantId: 'tenant',
          caseId: 'case',
          purpose,
          subjectId: 'effect',
        },
      ]);

      await f.check();
      expect(f.current()).toMatchObject({
        state: 'verified',
        proof: { evidenceRefs: ['source-proof'], complete: true },
      });
      // The same read cited again is stored once.
      expect(f.stored.map((s) => s.id)).toEqual(['source-proof']);
    });

    it('never passes on a partial read, and records the proof as incomplete', async () => {
      const f = fixture(kind);
      f.patch({ sent: true, state: 'uncertain' });
      f.setProofReads([read('source-proof', 'partial')]);
      expect(await f.verify()).toEqual({
        outcome: 'inconclusive',
        observationRefs: ['source-proof'],
      });
      expect(f.stored[0]).toMatchObject({ completeness: 'partial' });

      await f.check();
      expect(f.current().state).not.toBe('verified');
      expect(f.current().proof).toMatchObject({
        outcome: 'inconclusive',
        complete: false,
      });
    });

    it('cites nothing when a reference has no read to store', async () => {
      const f = fixture(kind);
      f.patch({ sent: true, state: 'uncertain' });
      f.setProofReads([]);
      expect(await f.verify()).toEqual({
        outcome: 'inconclusive',
        observationRefs: [],
      });
      await f.check();
      expect(f.current()).toMatchObject({
        state: 'uncertain',
        failure: 'stale_evidence',
        proof: null,
      });
      expect(f.stored).toEqual([]);
    });

    it('leaves the outcome unknown when the read cannot be stored', async () => {
      const f = fixture(kind);
      f.patch({ sent: true, state: 'uncertain' });
      f.setStorage('failing');
      await expect(f.verify()).rejects.toThrow('storage unavailable');
      await expect(f.check()).rejects.toThrow('storage unavailable');
      expect(f.current()).toMatchObject({ state: 'uncertain', proof: null });
    });
  },
);

describe.each(['settlement', 'exchange'] as const)(
  '%s write receipts',
  (kind) => {
    const acceptance: WriteAcceptance = {
      provider: 'shopify',
      connectionId: 'shopify',
      capability:
        kind === 'settlement' ? 'returns.restock' : 'returns.exchange.process',
      adapterVersion: 'shopify-returns/1',
      dispatchIdentity: '["shopify","shopify-returns/1"]',
      idempotencyKey: 'v0:action',
      acceptedAt: now.toISOString(),
      providerRequestId: 'request-1',
      records: [{ resource: 'return', externalId: 'gid://shopify/Return/1' }],
    };

    it('stores the accepted write once and returns the ID execution cites', async () => {
      const f = fixture(kind);
      const id = await f.storeReceipt(acceptance);
      expect(await f.storeReceipt(acceptance)).toBe(id);
      expect(f.receipts).toEqual([
        {
          kind: 'write_receipt',
          id,
          tenantId: 'tenant',
          caseId: 'case',
          purpose: kind,
          subjectId: 'effect',
          source: { provider: 'shopify', connectionId: 'shopify' },
          capability: acceptance.capability,
          adapterVersion: 'shopify-returns/1',
          dispatchIdentity: acceptance.dispatchIdentity,
          idempotencyKey: 'v0:action',
          observedAt: now.toISOString(),
          status: 'accepted',
          providerRequestId: 'request-1',
          records: acceptance.records,
        },
      ]);
    });

    it('refuses an acceptance from another connection or capability', async () => {
      const f = fixture(kind);
      for (const other of [
        { ...acceptance, connectionId: 'other' },
        { ...acceptance, capability: 'returns.create' as const },
      ])
        await expect(f.storeReceipt(other)).rejects.toThrow(
          'The receipt does not belong',
        );
      expect(f.receipts).toEqual([]);
    });

    it('throws when the receipt cannot be stored, so nothing is cited', async () => {
      const f = fixture(kind);
      f.setStorage('failing');
      await expect(f.storeReceipt(acceptance)).rejects.toThrow(
        'storage unavailable',
      );
      expect(f.receipts).toEqual([]);
    });
  },
);
