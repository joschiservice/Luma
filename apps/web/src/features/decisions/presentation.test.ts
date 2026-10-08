import type { DecisionItem } from '@luma/api-contract';
import { expect, it } from 'vitest';

import {
  actionable,
  decisionStatus,
  emptyCopy,
  groupDecisions,
  memberName,
  timeLeft,
} from './presentation';

const item = (id: string, group: string): DecisionItem =>
  ({ id, group: { key: group, label: group } }) as DecisionItem;

it('says who a decision waits for and only asks the reader when they can act', () => {
  expect(decisionStatus({ reason: 'approval', response: 'decide' })).toEqual({
    state: 'approval',
    label: 'Needs your approval',
  });
  expect(
    decisionStatus({ reason: 'approval', response: 'awaiting_other' }).label,
  ).toBe('Waiting for another approver');
  expect(decisionStatus({ reason: 'run', response: 'view_only' }).label).toBe(
    'Waiting for the requester',
  );
  expect(
    decisionStatus({ reason: 'recovery', response: 'view_only' }).label,
  ).toBe('Outcome not confirmed');
  expect(actionable({ response: 'check' })).toBe(true);
  expect(actionable({ response: 'awaiting_other' })).toBe(false);
});

it('counts down deadlines without claiming time that has passed', () => {
  const now = Date.parse('2026-09-30T09:00:00Z');
  expect(timeLeft('2026-09-30T09:04:30Z', now)).toBe('4 min left');
  expect(timeLeft('2026-09-30T09:00:30Z', now)).toBe('Under a minute left');
  expect(timeLeft('2026-09-30T12:00:00Z', now)).toBe('3 h left');
  expect(timeLeft('2026-09-30T08:59:59Z', now)).toBe('Expired');
});

it('groups common causes in ranking order without merging decisions', () => {
  const groups = groupDecisions([
    item('a', 'stock'),
    item('b', 'fulfillment'),
    item('c', 'stock'),
  ]);
  expect(groups.map((g) => [g.key, g.items.map((i) => i.id)])).toEqual([
    ['stock', ['a', 'c']],
    ['fulfillment', ['b']],
  ]);
});

it('explains empty views without implying healthy operations', () => {
  expect(emptyCopy('all', false).text).toContain('Connection health');
  expect(emptyCopy('mine', true).title).toBe('No matching decisions');
});

it('names members and marks the reader and former members', () => {
  const members = [{ userId: 'a', name: 'Alex Morgan' }];
  expect(memberName('a', members, 'b')).toBe('Alex Morgan');
  expect(memberName('b', members, 'b')).toBe('You');
  expect(memberName('c', members, 'b')).toBe('Former member');
  expect(memberName(null, members, 'b')).toBeNull();
});
