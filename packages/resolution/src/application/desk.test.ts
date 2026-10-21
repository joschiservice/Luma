import type { Diagnosis, Incident } from '@luma/exceptions';
import type { Permission, TenantContext } from '@luma/identity';
import type { PolicyDecision, ProposedAction } from '@luma/policies';
import { currentPolicyVersion } from '@luma/policies';
import { describe, expect, it, vi } from 'vitest';

import type { DeskSnapshot, DeskStore } from './desk.js';
import { createDeskService } from './desk.js';
import { testContext } from './tenant-context.fixture.js';

const now = new Date('2026-10-06T12:00:00Z');
const later = '2026-10-06T18:00:00.000Z';

/** A case whose current proposal waits for a person other than its requester. */
function snapshot(): DeskSnapshot {
  return {
    incident: { state: 'awaiting_approval' } as Incident,
    revision: 3,
    diagnosis: {
      status: 'ready',
      revision: 2,
      provenance: { validUntil: later },
    } as Diagnosis,
    proposal: {
      action: {
        id: 'proposal',
        expiresAt: later,
        preconditions: { validUntil: later },
        proposedBy: { kind: 'user', id: 'requester' },
      } as ProposedAction,
      actionHash: 'hash',
      version: 1,
      diagnosisRevision: 2,
    },
    decision: {
      id: 'decision',
      proposalId: 'proposal',
      actionHash: 'hash',
      outcome: 'approval_required',
      policyVersion: currentPolicyVersion,
      actorId: 'requester',
    } as PolicyDecision,
    approval: null,
    execution: null,
  };
}

function desk(fresh: TenantContext, overrides: Partial<DeskSnapshot> = {}) {
  const opened: string[] = [];
  const store: DeskStore = {
    withCase: (_context, id, _write, operation) => {
      opened.push(id);

      return operation({
        snapshot: { ...snapshot(), ...overrides },
        receipt: async () => null,
        respond: vi.fn(),
        save: vi.fn(),
        escalate: vi.fn(),
        close: vi.fn(async () => 4),
        people: async () => [],
      });
    },
    withRefresh: vi.fn(),
    bindWorkflow: vi.fn(),
    workflowSource: vi.fn(),
    publish: vi.fn(),
    proposal: vi.fn(),
    timeline: vi.fn(),
  };
  const service = createDeskService({
    store,
    refreshContext: async () => fresh,
    capability: () => true,
    checkCapability: async () => true,
    refreshProposal: vi.fn(),
    now: () => now,
  });

  return { service, opened };
}

const as = (permissions: Permission[]) =>
  testContext({ userId: 'operator', permissions });

describe('Case desk permissions', () => {
  it.each([
    [['issues.read'], [], false],
    [['issues.read', 'decisions.respond'], ['reject', 'approve'], false],
    [['issues.read', 'issues.manage'], ['close', 'escalate'], false],
    [['issues.read', 'actions.propose'], [], true],
  ] as const)(
    'offers only the decisions %j allows',
    async (permissions, decisions, refreshable) => {
      const context = as([...permissions]);
      const review = await desk(context).service.review(context, 'case');

      expect(review.permittedDecisions).toEqual(decisions);
      expect(review.refreshable).toBe(refreshable);
    },
  );

  it('rejects reads without issues.read before storage', async () => {
    const context = as(['decisions.respond']);
    const { service, opened } = desk(context);

    await expect(service.review(context, 'case')).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(opened).toEqual([]);
  });

  it.each([
    ['escalate', ['issues.read', 'decisions.respond']],
    ['close', ['issues.read', 'decisions.respond']],
    ['approve', ['issues.read', 'issues.manage']],
    ['reject', ['issues.read', 'issues.manage']],
  ] as const)(
    'rejects %s without its permission before storage',
    async (kind, permissions) => {
      const context = as([...permissions]);
      const { service, opened } = desk(context);
      const decision = service.decide(context, 'case', {
        commandId: 'command',
        kind,
        caseRevision: 3,
        diagnosisRevision: 2,
        proposalId: 'proposal',
        proposalVersion: 1,
        decisionId: 'decision',
        reason: 'Checked',
      });

      await expect(decision).rejects.toMatchObject({ statusCode: 403 });
      expect(opened).toEqual([]);
    },
  );
});

it('offers the requester a review only when independent approval is off', async () => {
  const context = testContext({
    userId: 'requester',
    permissions: ['issues.read', 'decisions.respond'],
  });
  expect(
    (await desk(context).service.review(context, 'case')).permittedDecisions,
  ).toEqual([]);
  expect(
    (
      await desk(context, { requireIndependentApproval: false }).service.review(
        context,
        'case',
      )
    ).permittedDecisions,
  ).toEqual(['reject', 'approve']);
  const reader = testContext({
    userId: 'requester',
    permissions: ['issues.read'],
  });
  expect(
    (
      await desk(reader, { requireIndependentApproval: false }).service.review(
        reader,
        'case',
      )
    ).permittedDecisions,
  ).toEqual([]);
});

it('allows closure after escalation or execution but never after resolution', async () => {
  const context = as(['issues.read', 'issues.manage']);
  for (const state of ['escalated', 'executing', 'failed'] as const) {
    const review = await desk(context, {
      incident: { state } as Incident,
    }).service.review(context, 'case');
    expect(review.permittedDecisions).toContain('close');
  }
  const review = await desk(context, {
    incident: { state: 'resolved' } as Incident,
  }).service.review(context, 'case');
  expect(review.permittedDecisions).toEqual([]);
});
