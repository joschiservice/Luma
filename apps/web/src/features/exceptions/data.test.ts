import { expect, it } from 'vitest';
import { inboxSearch, matchesView, casesOptions, caseOptions } from './data';
import type { CaseSummary } from '@luma/api-contract';
it('normalizes invalid deep-link filters', () => {
  expect(
    inboxSearch.parse({
      view: 'invalid',
      class: 'unknown',
      severity: 42,
      state: 'bad',
    }),
  ).toEqual({ view: 'needs_you' });
});
it('retains failed and escalated work in active, and only explicit attention in needs you', () => {
  const item = {
    class: 'inventory_mismatch',
    state: 'failed',
    severity: 'high',
    attention: { required: false },
  } as CaseSummary;
  expect(matchesView(item, { view: 'needs_you' })).toBe(false);
  expect(matchesView(item, { view: 'active' })).toBe(true);
  expect(
    matchesView({ ...item, state: 'escalated' }, { view: 'history' }),
  ).toBe(false);
  expect(matchesView({ ...item, state: 'resolved' }, { view: 'history' })).toBe(
    true,
  );
  expect(matchesView(item, { view: 'active', severity: 'medium' })).toBe(false);
});
it('separates tenant, selection and filter caches and refetches on focus', () => {
  expect(casesOptions('a', { view: 'active' }).queryKey).not.toEqual(
    casesOptions('b', { view: 'active' }).queryKey,
  );
  expect(caseOptions('a', 'first').queryKey).not.toEqual(
    caseOptions('a', 'second').queryKey,
  );
  expect(caseOptions('a', 'first').refetchOnWindowFocus).toBe('always');
});
