import { expect, it } from 'vitest';

import {
  actionable,
  assigneeOptions,
  decisionStatus,
  emptyCopy,
  memberName,
  timeLeft,
} from './presentation';

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
  expect(
    decisionStatus({
      kind: 'return_case',
      reason: 'manual_intervention',
      response: 'view_only',
    }),
  ).toEqual({ state: 'idle', label: 'View only' });
  expect(actionable({ response: 'check' })).toBe(true);
  expect(actionable({ response: 'awaiting_other' })).toBe(false);
});

it('counts down deadlines without claiming time that has passed', () => {
  const now = Date.parse('2026-09-30T09:00:00Z');
  expect(timeLeft('2026-09-30T09:04:30Z', now)).toBe('4m left');
  expect(timeLeft('2026-09-30T09:00:30Z', now)).toBe('<1m left');
  expect(timeLeft('2026-09-30T12:00:00Z', now)).toBe('3h left');
  expect(timeLeft('2026-09-30T08:59:59Z', now)).toBe('Expired');
});

it('explains empty views without implying healthy operations', () => {
  expect(emptyCopy('all', false).text).toContain('Connection health');
  expect(emptyCopy('mine', true).title).toBe('No matching decisions');
});

it('names members and marks the reader and former members', () => {
  const members = [
    { userId: 'a', name: 'Alex Morgan', email: 'alex@example.test' },
    { userId: 'd', name: 'Alex Morgan', email: 'alex.other@example.test' },
  ];
  expect(memberName('a', members, 'b')).toBe('Alex Morgan · alex@example.test');
  expect(memberName('b', members, 'b')).toBe('You');
  expect(memberName('d', members, 'b')).toBe(
    'Alex Morgan · alex.other@example.test',
  );
  expect(memberName('c', members, 'b')).toBe('Former member');
  expect(memberName(null, members, 'b')).toBeNull();
});

it('offers everyone but the holder, with the reader first and findable by name', () => {
  const members = [
    { userId: 'a', name: 'Alex Morgan', email: 'alex@example.com' },
    { userId: 'b', name: 'Bea Müller', email: 'bea@example.com' },
    { userId: 'c', email: 'casey@example.com' },
    { userId: 'd' },
  ];

  expect(assigneeOptions(members, 'a', 'b')).toEqual([
    { id: 'b', name: 'You', detail: 'Bea Müller · bea@example.com' },
    { id: 'c', name: 'casey@example.com', detail: undefined },
    { id: 'd', name: 'Member', detail: undefined },
  ]);
  expect(assigneeOptions(members, null, undefined)[0]).toEqual({
    id: 'a',
    name: 'Alex Morgan',
    detail: 'alex@example.com',
  });
});
