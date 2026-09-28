import { describe, expect, it } from 'vitest';

import {
  adaptCase,
  checkTestCase,
  defaultCase,
  repliesFromOutputs,
  sameStep,
} from './draft-test.js';
import { processVersion } from './process.fixture.js';

const id = '00000000-0000-4000-8000-000000000001';

/** Copies a record without the named keys. */
function omit<T extends object>(record: T, ...keys: string[]): T {
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => !keys.includes(key)),
  ) as T;
}

describe('draft test cases', () => {
  it('prefills every declared field and reply with documented defaults', () => {
    const example = defaultCase(
      {
        ...processVersion,
        inputs: {
          note: 'string',
          count: 'number',
          flag: 'boolean',
          none: 'null',
        },
      },
      id,
    );
    expect(example).toEqual({
      id,
      name: 'Example',
      inputs: { note: '', count: 0, flag: false, none: null },
      evidence: { ready: false },
      replies: {
        refresh: { kind: 'read', values: { ready: false } },
        review: { kind: 'approval', decision: 'approved' },
        reserve: { kind: 'capability', result: 'accepted' },
        verify: {
          kind: 'verification',
          state: 'verified',
          values: { reserved: false },
        },
      },
      expected: null,
    });
    expect(
      checkTestCase(processVersion, defaultCase(processVersion, id)),
    ).toEqual([]);
  });

  it('explains each mismatch on the step and field to change', () => {
    const base = defaultCase(processVersion, id);
    const problems = checkTestCase(processVersion, {
      ...base,
      name: ' ',
      inputs: { quantity: 'two', extra: 1 },
      evidence: {},
      replies: {
        refresh: { kind: 'read', values: { ready: 'yes' } },
        eligible: { kind: 'approval', decision: 'approved' },
        review: { kind: 'capability', result: 'accepted' },
        ghost: { kind: 'read', values: {} },
      },
    });
    expect(problems).toEqual([
      { stepId: null, field: 'name', message: 'Name this test case.' },
      {
        stepId: null,
        field: 'inputs.quantity',
        message: '“quantity” must be a number.',
      },
      {
        stepId: null,
        field: 'inputs.extra',
        message: "Remove “extra”. It isn't a declared field.",
      },
      {
        stepId: null,
        field: 'evidence.ready',
        message: 'Enter an example value for “ready”.',
      },
      {
        stepId: 'refresh',
        field: 'values.ready',
        message: '“ready” must be yes or no.',
      },
      {
        stepId: 'eligible',
        field: null,
        message: "“eligible” doesn't take an example reply. Remove it.",
      },
      {
        stepId: 'review',
        field: null,
        message: '“review” needs an approval reply.',
      },
      {
        stepId: 'ghost',
        field: null,
        message: 'This workflow has no step “ghost”. Remove its example reply.',
      },
      {
        stepId: 'reserve',
        field: null,
        message: 'Choose what happens when this action is requested.',
      },
    ]);
  });

  it('requires result checks only for accepted actions and lets approvals stay undecided', () => {
    const replies = omit(
      defaultCase(processVersion, id).replies,
      'review',
      'verify',
    );
    const base = defaultCase(processVersion, id);
    expect(
      checkTestCase(processVersion, { ...base, replies }).map(
        (problem) => problem.stepId,
      ),
    ).toEqual(['verify']);
    expect(
      checkTestCase(processVersion, {
        ...base,
        replies: {
          ...replies,
          reserve: { kind: 'capability', result: 'denied' },
        },
      }),
    ).toEqual([]);
    const withoutRead = omit(base.replies, 'refresh');
    expect(
      checkTestCase(processVersion, { ...base, replies: withoutRead }),
    ).toEqual([
      {
        stepId: 'refresh',
        field: null,
        message: 'Give an example reply for this read.',
      },
    ]);
  });

  it('applies reference replies to customized copies by read source, action and result check', () => {
    const copy = {
      ...processVersion,
      inputs: { quantity: 'number' as const, reason: 'string' as const },
      steps: processVersion.steps.map((step) =>
        step.kind === 'read'
          ? {
              ...step,
              id: 'current',
              fields: { ready: 'boolean' as const, spare: 'number' as const },
            }
          : step.kind === 'capability'
            ? { ...step, id: 'hold' }
            : step.kind === 'verification'
              ? { ...step, id: 'confirm', forStep: 'hold' }
              : step,
      ),
    };
    const base = defaultCase(copy, id);
    const adapted = adaptCase(
      copy,
      processVersion,
      {
        inputs: { quantity: 7, unknown: true },
        evidence: { ready: 'wrong type' },
        replies: {
          refresh: { kind: 'read', values: { ready: true, extra: 1 } },
          reserve: { kind: 'capability', result: 'approval_required' },
          verify: {
            kind: 'verification',
            state: 'failed',
            values: { reserved: false },
          },
        },
      },
      base,
    );
    expect(adapted.inputs).toEqual({ quantity: 7, reason: '' });
    expect(adapted.evidence).toEqual({ ready: false });
    expect(adapted.replies).toEqual({
      current: { kind: 'read', values: { ready: true, spare: 0 } },
      review: { kind: 'approval', decision: 'approved' },
      hold: { kind: 'capability', result: 'approval_required' },
      confirm: {
        kind: 'verification',
        state: 'failed',
        values: { reserved: false },
      },
    });
    expect(sameStep(copy.steps[0]!, processVersion.steps[0]!)).toBe(true);
    expect(
      sameStep(
        { ...copy.steps[0]!, source: 'other' } as (typeof copy.steps)[number],
        processVersion.steps[0]!,
      ),
    ).toBe(false);
  });

  it('turns a real run’s recorded steps into replies', () => {
    const at = '2026-09-28T10:00:00Z';
    expect(
      repliesFromOutputs([
        {
          stepId: 'refresh',
          kind: 'read',
          state: 'completed',
          values: { ready: true },
          evidenceRefs: ['r'],
          recordedAt: at,
        },
        {
          stepId: 'review',
          kind: 'approval',
          state: 'waiting',
          values: {},
          evidenceRefs: ['d'],
          recordedAt: at,
        },
        {
          stepId: 'review',
          kind: 'approval',
          state: 'completed',
          values: { approved: true },
          evidenceRefs: ['d'],
          recordedAt: at,
        },
        {
          stepId: 'reserve',
          kind: 'capability',
          state: 'escalated',
          values: {},
          evidenceRefs: ['p'],
          recordedAt: at,
        },
        {
          stepId: 'verify',
          kind: 'verification',
          state: 'inconclusive',
          values: { reserved: false },
          evidenceRefs: ['v'],
          recordedAt: at,
        },
      ]),
    ).toEqual({
      refresh: { kind: 'read', values: { ready: true } },
      review: { kind: 'approval', decision: 'approved' },
      reserve: { kind: 'capability', result: 'denied' },
      verify: {
        kind: 'verification',
        state: 'inconclusive',
        values: { reserved: false },
      },
    });
  });
});
