import { describe, expect, it } from 'vitest';

import type { PurchasingTimelineEntry } from './purchasing-timeline.js';
import {
  attributeTimelineActors,
  timelineActorIds,
  timelineActorKind,
  timelineAutomationSources,
} from './timeline-actors.js';

const entry = (
  id: string,
  overrides: Partial<PurchasingTimelineEntry> = {},
): PurchasingTimelineEntry => ({
  id,
  kind: 'submission',
  stage: 'sent',
  at: '2026-10-13T12:00:00.000Z',
  actorId: null,
  reason: null,
  evidenceRefs: [],
  quantity: null,
  unit: null,
  revision: null,
  detail: null,
  source: 'luma',
  ...overrides,
});

const run = { id: 'run-1', name: 'Reorder', principalId: 'owner' };

describe('timelineActorKind', () => {
  it('distinguishes members, former members and unrecorded actors', () => {
    const person = { id: 'a', name: 'A', email: null, member: true };

    expect(timelineActorKind('a', person)).toBe('member');
    expect(timelineActorKind('a', { ...person, member: false })).toBe(
      'former_member',
    );
    expect(timelineActorKind('gone', undefined)).toBe('former_member');
    expect(timelineActorKind(null, undefined)).toBe('unrecorded');
  });
});

describe('timelineAutomationSources', () => {
  it('reads execution and submission ids from entry ids', () => {
    expect(
      timelineAutomationSources([
        entry('execution:x-1'),
        entry('submission:s-1:sent'),
        entry('commitment:c-1'),
      ]),
    ).toEqual({ executionIds: ['x-1'], submissionIds: ['s-1'] });
  });
});

describe('attributeTimelineActors', () => {
  it('attributes automated submissions to the run principal and workflow', () => {
    const automated = new Map([['submission:s-1', run]]);
    const people = new Map([
      ['owner', { id: 'owner', name: 'Olive', email: 'o@x', member: true }],
    ]);

    expect(timelineActorIds([entry('submission:s-1:sent')], automated)).toEqual(
      ['owner'],
    );
    expect(
      attributeTimelineActors([entry('submission:s-1:sent')], {
        automated,
        people,
      })[0]!.actor,
    ).toEqual({
      kind: 'member',
      id: 'owner',
      name: 'Olive',
      email: 'o@x',
      workflow: { id: 'run-1', name: 'Reorder' },
    });
  });

  it('keeps human decisions with the deciding person, not the run', () => {
    const [decision] = attributeTimelineActors(
      [entry('submission:s-1:approved', { stage: 'approved' })],
      { automated: new Map([['submission:s-1', run]]), people: new Map() },
    );

    expect(decision!.actor).toEqual({
      kind: 'unrecorded',
      id: null,
      name: null,
      email: null,
      workflow: null,
    });
  });

  it('names the drafting workflow only on the created entry', () => {
    const workflow = { id: 'draft-run', name: 'Draft reorder' };
    const [created, other] = attributeTimelineActors(
      [
        entry('lifecycle:1', { detail: 'created', actorId: 'gone' }),
        entry('lifecycle:2', { detail: 'opened', actorId: 'gone' }),
      ],
      { automated: new Map(), people: new Map(), workflow },
    );

    expect(created!.actor).toMatchObject({ kind: 'former_member', workflow });
    expect(other!.actor?.workflow).toBeNull();
  });
});
