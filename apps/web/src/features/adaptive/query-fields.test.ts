import { adaptiveViewDomainSchema } from '@luma/api-contract';
import { describe, expect, it } from 'vitest';

import { filterChoices, filterFields, sortFields } from './query-fields';

describe('owner query authoring metadata', () => {
  it('reads the input vocabulary even when owner schemas transform submitted values', () => {
    for (const domain of adaptiveViewDomainSchema.options) {
      expect(() => sortFields(domain)).not.toThrow();
      for (const field of filterFields(domain))
        expect(() => filterChoices(domain, field)).not.toThrow();
    }
    expect(filterChoices('orders', 'status')).toContain('open');
    expect(sortFields('orders')).toContain('updated');
    expect(filterFields('orders')).not.toContain('cursor');
    expect(sortFields('inventory')).toEqual([]);
  });
});
