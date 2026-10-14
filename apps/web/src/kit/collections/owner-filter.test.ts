import { expect, it } from 'vitest';

import { ownerChoice, ownerCondition } from './owner-filter';

const owner = { field: 'owner', members: [], unassigned: true };
const person = '6f8a1c2e-3b4d-4e5f-8a6b-7c8d9e0f1a2b';

it('writes me, unassigned and one person as conditions shared views can resolve', () => {
  expect(ownerCondition('owner', 'me')).toEqual({
    field: 'owner',
    op: 'any_of',
    value: [{ dynamic: 'me' }],
  });
  expect(ownerCondition('owner', 'unassigned')).toEqual({
    field: 'owner',
    op: 'empty',
  });
  expect(ownerCondition('owner', person)).toEqual({
    field: 'owner',
    op: 'any_of',
    value: [person],
  });
});

it('reads back only the owner conditions the pill can show', () => {
  for (const choice of ['me', 'unassigned', person])
    expect(ownerChoice(ownerCondition('owner', choice), owner)).toBe(choice);
  // Several people, other fields and Unassigned where it is not offered stay chips.
  expect(
    ownerChoice(
      { field: 'owner', op: 'any_of', value: [person, { dynamic: 'me' }] },
      owner,
    ),
  ).toBeUndefined();
  expect(
    ownerChoice({ field: 'state', op: 'any_of', value: ['open'] }, owner),
  ).toBeUndefined();
  expect(
    ownerChoice(
      { field: 'owner', op: 'empty' },
      { ...owner, unassigned: false },
    ),
  ).toBeUndefined();
});
