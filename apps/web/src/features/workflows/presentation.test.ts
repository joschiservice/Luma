import type { WorkflowReadiness, WorkflowRunView } from '@luma/api-contract';
import { describe, expect, it } from 'vitest';

import {
  inRunView,
  needsAttention,
  runOutcome,
  workflowLifecycle,
  workflowStatus,
  workflowTriggerLabel,
} from './presentation';

const readiness = (
  patch: Partial<WorkflowReadiness> = {},
): WorkflowReadiness => ({
  enablement: 'not_enabled',
  state: 'ready',
  issues: [],
  coverage: { unit: 'order', covered: 0, ready: 0, explanation: 'None.' },
  approval: { mode: 'every_action', summary: 'Every change.', details: [] },
  waiting: { count: 0, repair: null },
  outcomes: null,
  nextAction: { label: 'Turn on', description: 'Off.', repair: null },
  ...patch,
});

const run = (patch: Partial<WorkflowRunView> = {}): WorkflowRunView => ({
  id: '10000000-0000-4000-8000-000000000001',
  createdAt: '2026-10-15T09:40:00.000Z',
  version: '1.0.0',
  versionDigest: 'a'.repeat(64),
  activationId: null,
  evidenceKind: 'live',
  execution: 'not_recorded',
  verification: 'not_verified',
  reason: 'No outcome recorded',
  story: { context: 'c', decision: 'd', action: 'a', verification: 'v' },
  trigger: { kind: 'manual' },
  subject: { kind: 'order', id: 'order-1' },
  actor: { kind: 'user', id: 'ada' },
  contextDigest: 'c'.repeat(64),
  steps: [],
  ...patch,
});

describe('workflow status', () => {
  it('treats an off workflow that is blocked as needing setup, not as failing', () => {
    const blocked = readiness({ state: 'blocked' });

    expect(needsAttention(blocked)).toBe(false);
    expect(workflowLifecycle(blocked)).toBe('setup');
    expect(workflowStatus(blocked)).toEqual({
      label: 'Needs setup',
      state: 'waiting',
    });
  });

  it('raises a workflow that is on and blocked as one that can’t run', () => {
    const blocked = readiness({ enablement: 'enabled', state: 'blocked' });

    expect(workflowLifecycle(blocked)).toBe('attention');
    expect(workflowStatus(blocked)).toEqual({
      label: 'Can’t run',
      state: 'error',
    });
  });

  it('keeps partial coverage visible while a workflow runs', () => {
    expect(
      workflowStatus(readiness({ enablement: 'enabled', state: 'degraded' })),
    ).toEqual({ label: 'On with gaps', state: 'attention' });
    expect(
      workflowLifecycle(readiness({ enablement: 'enabled', state: 'ready' })),
    ).toBe('on');
  });

  it('needs attention for waiting decisions or an unresolved latest run, even when off', () => {
    expect(
      needsAttention(readiness({ waiting: { count: 2, repair: null } })),
    ).toBe(true);
    expect(
      needsAttention(
        readiness({
          outcomes: {
            runs: 1,
            verified: 0,
            unresolved: 1,
            inProgress: 0,
            latest: {
              runId: 'run',
              state: 'unresolved',
              at: '2026-10-15T09:40:00.000Z',
              summary: 'The result could not be confirmed.',
            },
            recent: [{ state: 'unresolved', at: '2026-10-15T09:40:00.000Z' }],
          },
        }),
      ),
    ).toBe(true);
    expect(
      needsAttention(readiness({ waiting: { count: null, repair: null } })),
    ).toBe(false);
  });

  it('separates paused and ready-to-turn-on workflows', () => {
    expect(workflowLifecycle(readiness({ enablement: 'paused' }))).toBe(
      'paused',
    );
    expect(workflowLifecycle(readiness())).toBe('available');
    expect(workflowStatus(readiness())).toEqual({
      label: 'Off',
      state: 'idle',
    });
  });
});

describe('run outcome', () => {
  it('reads only an independent verification as verified', () => {
    expect(runOutcome(run({ execution: 'accepted' }))).toMatchObject({
      outcome: 'active',
      label: 'Not verified yet',
    });
    expect(runOutcome(run({ verification: 'verified' }))).toMatchObject({
      outcome: 'verified',
      state: 'verified',
    });
    expect(runOutcome(run({ processState: 'verified' })).outcome).toBe(
      'verified',
    );
  });

  it('puts failed checks, handovers and waiting decisions under Needs a look', () => {
    const failed = run({ processState: 'failed_verification' });
    const escalated = run({ processState: 'escalated' });
    const waiting = run({ processState: 'awaiting_decision' });
    const legacyWaiting = run({ execution: 'awaiting_approval' });

    for (const item of [failed, escalated, waiting, legacyWaiting])
      expect(inRunView(item, 'attention')).toBe(true);
    expect(runOutcome(failed).state).toBe('error');
    expect(inRunView(run({ processState: 'running' }), 'attention')).toBe(
      false,
    );
  });

  it('labels trigger states before process states', () => {
    expect(
      runOutcome(run({ triggerState: 'scheduled', processState: 'waiting' })),
    ).toMatchObject({ outcome: 'active', label: 'Scheduled' });
    expect(runOutcome(run({ triggerState: 'skipped' }))).toMatchObject({
      outcome: 'ended',
      label: 'Skipped',
    });
  });
});

describe('trigger label', () => {
  it('names detected issues the way Issues does and keeps unknown types readable', () => {
    expect(
      workflowTriggerLabel({ kind: 'exception', issueType: 'sync_failure' }),
    ).toBe('Connection issue detected');
    expect(
      workflowTriggerLabel({ kind: 'exception', issueType: 'late_invoice' }),
    ).toBe('Late invoice detected');
  });
});
