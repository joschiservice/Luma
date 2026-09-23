import { describe, expect, it } from 'vitest';

import {
  candidateAction,
  type ShadowEvaluation,
  shadowLatestOptions,
  shadowWindow,
} from './data';
import { fieldRows, readFields } from './review-fields';

describe('Shadow comparison inputs', () => {
  it('uses inclusive UTC calendar days and rejects invalid dates or reversed windows', () => {
    expect(shadowWindow('shipping', '2026-09-23', '2026-09-23')).toEqual({
      workflow: 'shipping',
      since: '2026-09-23T00:00:00.000Z',
      until: '2026-09-24T00:00:00.000Z',
    });
    expect(() =>
      shadowWindow('shipping', '2026-02-30', '2026-03-01'),
    ).toThrow();
    expect(() =>
      shadowWindow('shipping', '2026-09-24', '2026-09-23'),
    ).toThrow();
  });
  it('isolates case and Playbook queries by workspace', () => {
    expect(shadowLatestOptions('a', 'case', 'shipping').queryKey).not.toEqual(
      shadowLatestOptions('b', 'case', 'shipping').queryKey,
    );
    expect(shadowLatestOptions('a', 'case', 'shipping').queryKey).not.toEqual(
      shadowLatestOptions('a', 'other', 'shipping').queryKey,
    );
  });
  it('preserves scalar types and rejects duplicate names or invalid numbers', () => {
    const values = {
      method: 'EXPRESS',
      quantity: 2,
      enabled: false,
      optional: null,
    };
    expect(readFields(fieldRows(values))).toEqual(values);
    expect(() =>
      readFields([
        ...fieldRows({ quantity: 2 }),
        ...fieldRows({ quantity: 3 }),
      ]),
    ).toThrow('unique');
    expect(() =>
      readFields([{ id: '1', name: 'quantity', kind: 'number', value: '' }]),
    ).toThrow('valid number');
    expect(readFields(fieldRows(JSON.parse('{"__proto__":"safe"}')))).toEqual(
      JSON.parse('{"__proto__":"safe"}'),
    );
  });
  it('does not infer an action from malformed or missing candidate fields', () => {
    expect(candidateAction({ candidate: null } as ShadowEvaluation)).toBeNull();
    expect(
      candidateAction({
        candidate: { action: { capability: 'shipping' } },
      } as unknown as ShadowEvaluation),
    ).toBeNull();
  });
});
