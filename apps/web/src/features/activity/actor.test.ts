import { actorLabel, authorLabel, personLabel } from '@luma/ui/lib/actor';
import { expect, it } from 'vitest';

const ada = {
  kind: 'member' as const,
  id: 'user-1',
  name: 'Ada Lovelace',
  email: 'ada@example.test',
  workflow: null,
};

it('names people, former members, Luma and services instead of IDs', () => {
  expect(actorLabel(ada)).toBe('Ada Lovelace');
  expect(actorLabel(ada, { email: true })).toBe(
    'Ada Lovelace · ada@example.test',
  );
  expect(
    actorLabel({
      ...ada,
      workflow: { id: 'replenish', name: 'Replenish low stock' },
    }),
  ).toBe('Ada Lovelace via Replenish low stock');
  expect(actorLabel({ ...ada, kind: 'former_member', email: null })).toBe(
    'Ada Lovelace (former member)',
  );
  expect(actorLabel({ ...ada, kind: 'former_member', name: null })).toBe(
    'Former member',
  );
  expect(actorLabel({ ...ada, kind: 'luma', id: null })).toBe('Luma');
  expect(
    actorLabel({ ...ada, kind: 'service', name: 'luma.procurement' }),
  ).toBe('Service luma.procurement');
  expect(actorLabel({ ...ada, kind: 'unrecorded' })).toBe('Actor not recorded');
});

it('treats a person missing from the listed people as a former member', () => {
  expect(personLabel([ada], 'user-1')).toBe('Ada Lovelace');
  expect(personLabel([ada], 'user-2')).toBe('Former member');
});

it('names authors that are people and keeps authors that are names already', () => {
  expect(authorLabel([ada], 'user-1')).toBe('Ada Lovelace');
  expect(authorLabel([ada], 'Luma')).toBe('Luma');
});
