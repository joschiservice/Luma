import { describe, expect, it } from 'vitest';

import type {
  CollectionCondition,
  CollectionWhere,
} from '../../application/collections.js';
import type { DecisionItem } from '../../application/decisions.js';
import {
  compareKeys,
  decisionKeys,
  filterDecisions,
  groupDecisions,
  type RankedDecision,
} from './list.js';

const reader = '6f8a1c2e-3b4d-4e5f-8a6b-7c8d9e0f1a2b';
const now = new Date('2026-10-14T10:00:00.000Z');
const context = { readerId: reader, now, timeZone: 'Europe/Berlin' };

function decision(
  id: string,
  input: Partial<DecisionItem> & { rank?: number } = {},
): RankedDecision {
  const { rank = 2, ...item } = input;

  return {
    rank,
    deadlineKey: item.deadline ?? 'infinity',
    item: {
      id,
      kind: 'human_task',
      reason: 'approval',
      domain: 'procurement',
      title: `Approve ${id}`,
      why: '',
      consequences: [],
      change: [],
      impact: { level: 'unknown', text: null },
      urgency: 'normal',
      requestedAt: '2026-10-14T08:00:00.000Z',
      deadline: null,
      requesterId: null,
      evidence: { observedAt: null, validUntil: null, state: 'unknown' },
      response: 'investigate',
      assignment: null,
      subject: { label: id, detail: null },
      record: null,
      owner: { kind: 'case', exceptionId: id },
      group: { key: 'drafts', label: 'Drafts' },
      ...item,
    },
  };
}

const assigned = {
  assigneeId: reader,
  assignedBy: reader,
  assignedAt: '2026-10-14T08:00:00.000Z',
  revision: 1,
};

const queue = [
  decision('a', { rank: 1, impact: { level: 'high', text: null } }),
  decision('b', {
    domain: 'inventory',
    reason: 'manual_intervention',
    assignment: assigned,
    requestedAt: '2026-10-13T22:30:00.000Z',
    group: { key: 'counts', label: 'Counts' },
  }),
  decision('c', { deadline: '2026-10-14T12:00:00.000Z' }),
];

const ids = (decisions: readonly RankedDecision[]) =>
  decisions.map((entry) => entry.item.id);

describe('Needs you list', () => {
  it('filters by owner, area, deadline and the reader’s local days', () => {
    const where = (...conditions: CollectionCondition[]): CollectionWhere => ({
      match: 'all',
      conditions,
    });
    expect(
      ids(
        filterDecisions(
          queue,
          where({ field: 'owner', op: 'any_of', value: [{ dynamic: 'me' }] }),
          undefined,
          context,
        ),
      ),
    ).toEqual(['b']);
    expect(
      ids(
        filterDecisions(
          queue,
          where({ field: 'owner', op: 'empty' }),
          undefined,
          context,
        ),
      ),
    ).toEqual(['a', 'c']);
    expect(
      ids(
        filterDecisions(
          queue,
          where({ field: 'domain', op: 'none_of', value: ['procurement'] }),
          undefined,
          context,
        ),
      ),
    ).toEqual(['b']);
    expect(
      ids(
        filterDecisions(
          queue,
          where({ field: 'deadline', op: 'not_empty' }),
          undefined,
          context,
        ),
      ),
    ).toEqual(['c']);
    // 22:30 UTC on 13 October is already 14 October in Berlin.
    expect(
      ids(
        filterDecisions(
          queue,
          where({
            field: 'requested',
            op: 'between',
            value: { from: '2026-10-14', to: '2026-10-14' },
          }),
          undefined,
          context,
        ),
      ),
    ).toEqual(['a', 'b', 'c']);
    expect(
      ids(filterDecisions(queue, undefined, ' approve C ', context)),
    ).toEqual(['c']);
    expect(() =>
      filterDecisions(
        [],
        where({ field: 'title', op: 'any_of', value: ['x'] }),
        undefined,
        context,
      ),
    ).toThrow('cannot be filtered');
  });

  it('keeps decisions without a deadline last in both directions', () => {
    const order = (direction: 'asc' | 'desc') =>
      ids(
        [...queue].sort((left, right) =>
          compareKeys(
            decisionKeys(left, 'deadline'),
            decisionKeys(right, 'deadline'),
            direction,
          ),
        ),
      );
    expect(order('asc')[0]).toBe('c');
    expect(order('desc')[0]).toBe('c');
    expect(
      ids(
        [...queue].sort((left, right) =>
          compareKeys(
            decisionKeys(left, 'urgency'),
            decisionKeys(right, 'urgency'),
            'asc',
          ),
        ),
      ),
    ).toEqual(['a', 'c', 'b']);
  });

  it('groups by cause with exact counts and a page link for the rest', () => {
    const result = groupDecisions(queue, 'cause', {}, 1, false, (key) =>
      String(key),
    );
    expect(
      result.groups.map((group) => [group.key, group.count, group.itemIds]),
    ).toEqual([
      ['drafts', 2, ['a']],
      ['counts', 1, ['b']],
    ]);
    expect(result.groups[0]).toMatchObject({
      complete: false,
      nextCursor: 'drafts',
    });
    expect(
      groupDecisions(
        queue,
        'reason',
        { reason: ['approval', 'manual_intervention'] },
        10,
        true,
        String,
      ).groups.map((group) => group.key),
    ).toEqual(['approval', 'manual_intervention']);
    expect(() => groupDecisions(queue, 'title', {}, 10, true, String)).toThrow(
      'cannot be grouped',
    );
  });
});
