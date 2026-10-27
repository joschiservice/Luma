import { expect, it } from 'vitest';

import { processVersion } from './process.fixture.js';
import type { ProcessStepOutput } from './process.js';
import {
  closedExecutionSettlement,
  processSettlement,
} from './process-settlement.js';

const output = (
  stepId: string,
  kind: ProcessStepOutput['kind'],
  state: ProcessStepOutput['state'],
): ProcessStepOutput => ({
  stepId,
  kind,
  state,
  values: {},
  evidenceRefs: ['evidence'],
  recordedAt: '2026-09-27T00:00:00Z',
});

const settle = (outputs: ProcessStepOutput[]) =>
  processSettlement(
    { id: 'run' },
    processVersion,
    outputs,
    'process_execution_closed',
    '2026-09-27T00:01:00Z',
  );

it('settles at the first step, a waiting step or the step after the last completed one', () => {
  expect(settle([])).toEqual({
    stepId: 'refresh',
    kind: 'read',
    state: 'escalated',
    values: {},
    evidenceRefs: ['temporal:run:refresh'],
    recordedAt: '2026-09-27T00:01:00Z',
    reason: 'process_execution_closed',
  });
  expect(
    settle([
      output('refresh', 'read', 'completed'),
      output('eligible', 'condition', 'completed'),
      output('review', 'approval', 'waiting'),
    ]),
  ).toMatchObject({ stepId: 'review', kind: 'approval' });
  expect(settle([output('refresh', 'read', 'completed')])).toMatchObject({
    stepId: 'eligible',
    kind: 'condition',
  });
});

it('records nothing for a run that already ended', () => {
  expect(settle([output('eligible', 'condition', 'escalated')])).toBeNull();
  expect(settle([output('finish', 'end', 'completed')])).toBeNull();
  expect(settle([output('unknown', 'read', 'completed')])).toBeNull();
});

it('settles only runs whose execution closed without completing', () => {
  const closed = (started: unknown) =>
    closedExecutionSettlement(
      started,
      { id: 'run' },
      processVersion,
      [],
      '2026-09-27T00:01:00Z',
    );

  for (const closure of ['failed', 'cancelled', 'terminated', 'timed_out'])
    expect(closed({ workflowId: 'run', closed: closure })).toMatchObject({
      stepId: 'refresh',
      state: 'escalated',
      reason: 'process_execution_closed',
    });
  expect(closed({ workflowId: 'run', closed: 'completed' })).toBeNull();
  expect(closed({ workflowId: 'run', closed: null })).toBeNull();
  expect(closed(undefined)).toBeNull();
});
