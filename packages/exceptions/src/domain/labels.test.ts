import { expect, it } from 'vitest';

import { exceptionClassLabel } from './labels.js';

it('names known classes and falls back for unknown or inherited keys', () => {
  expect(exceptionClassLabel('inventory_mismatch')).toBe('Stock mismatch');
  expect(exceptionClassLabel('retired_class')).toBe('Operational issue');
  expect(exceptionClassLabel('toString')).toBe('Operational issue');
});
