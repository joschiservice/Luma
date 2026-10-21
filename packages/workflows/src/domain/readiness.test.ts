import { describe, expect, it } from 'vitest';

import {
  assessReadiness,
  describeApproval,
  type ReadinessIssue,
  summarizeOutcomes,
} from './readiness.js';

const approval = describeApproval(
  { mode: 'every_action', reason: 'minimum_risk' },
  'purchase-order draft',
);
const base = {
  enablement: 'enabled' as const,
  issues: [] as ReadinessIssue[],
  coverage: { unit: 'stock position', covered: 2, ready: 2, explanation: '' },
  approval,
  waiting: { count: 0, repair: null },
  outcomes: null,
  enable: { label: 'Add a stock rule', destination: 'workflow_rules' as const },
  idle: 'Luma checks 2 stock positions.',
};
const issue = (
  severity: ReadinessIssue['severity'],
  code = 'stock_expired',
): ReadinessIssue => ({
  code,
  severity,
  message: 'The latest stock read is older than five minutes.',
  scope: 'SKU-1',
  repair: {
    label: 'Review stock for SKU-1',
    destination: 'inventory_position',
    recordId: 'position',
  },
});

describe('assessReadiness', () => {
  it('keeps an enabled workflow blocked when access is unusable', () => {
    const readiness = assessReadiness({
      ...base,
      issues: [issue('blocking', 'connection_access')],
    });

    expect(readiness.enablement).toBe('enabled');
    expect(readiness.state).toBe('blocked');
    expect(readiness.nextAction).toEqual({
      label: 'Review stock for SKU-1',
      description: 'SKU-1: The latest stock read is older than five minutes.',
      repair: issue('blocking').repair,
    });
  });

  it('puts waiting decisions before partial coverage', () => {
    const readiness = assessReadiness({
      ...base,
      issues: [issue('degrading')],
      waiting: {
        count: 2,
        repair: { label: 'Open Needs you', destination: 'needs_you' },
      },
    });

    expect(readiness.state).toBe('degraded');
    expect(readiness.nextAction.label).toBe('Review 2 waiting decisions');
    expect(readiness.nextAction.repair?.destination).toBe('needs_you');
  });

  it('asks for setup only when nothing is broken', () => {
    expect(
      assessReadiness({ ...base, enablement: 'not_enabled' }).nextAction.label,
    ).toBe('Add a stock rule');
    expect(
      assessReadiness({
        ...base,
        enablement: 'not_enabled',
        issues: [issue('blocking', 'worker_unavailable')],
      }).nextAction.label,
    ).toBe('Review stock for SKU-1');
  });

  it('points to the latest run when it ended unresolved', () => {
    const readiness = assessReadiness({
      ...base,
      outcomes: summarizeOutcomes(
        [
          {
            id: 'run-2',
            createdAt: '2026-10-03T08:00:00.000Z',
            state: 'inconclusive_verification',
          },
          {
            id: 'run-1',
            createdAt: '2026-10-02T08:00:00.000Z',
            state: 'verified',
          },
        ],
        () => 'The result couldn’t be confirmed.',
      ),
    });

    expect(readiness.state).toBe('ready');
    expect(readiness.nextAction.repair).toEqual({
      label: 'Review the latest run',
      destination: 'workflow_activity',
      recordId: 'run-2',
    });
  });

  it('reports nothing needed for a healthy enabled workflow', () => {
    expect(assessReadiness(base).nextAction).toEqual({
      label: 'Nothing needed',
      description: 'Luma checks 2 stock positions.',
      repair: null,
    });
  });
});

describe('summarizeOutcomes', () => {
  it('counts only verification as verified and runs that did not act as neither', () => {
    const summary = summarizeOutcomes(
      [
        { id: 'a', createdAt: '2026-10-03T08:00:00.000Z', state: 'ended' },
        { id: 'b', createdAt: '2026-10-02T08:00:00.000Z', state: 'verified' },
        { id: 'c', createdAt: '2026-10-01T08:00:00.000Z', state: 'denied' },
        { id: 'd', createdAt: '2026-09-30T08:00:00.000Z', state: undefined },
      ],
      (state) => String(state),
    );

    expect(summary).toMatchObject({
      runs: 4,
      verified: 1,
      unresolved: 1,
      inProgress: 1,
      latest: { runId: 'a', state: 'ended' },
      recent: [
        { state: 'ended', at: '2026-10-03T08:00:00.000Z' },
        { state: 'verified', at: '2026-10-02T08:00:00.000Z' },
        { state: 'unresolved', at: '2026-10-01T08:00:00.000Z' },
        { state: 'in_progress', at: '2026-09-30T08:00:00.000Z' },
      ],
    });
  });

  it('lists only the most recent outcomes one by one', () => {
    const summary = summarizeOutcomes(
      Array.from({ length: 30 }, (_, index) => ({
        id: String(index),
        createdAt: '2026-10-01T08:00:00.000Z',
        state: 'verified',
      })),
      String,
    );

    expect(summary.runs).toBe(30);
    expect(summary.recent).toHaveLength(10);
  });
});
