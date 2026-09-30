import { describe, expect, it } from 'vitest';

import { readableKey } from './labels.js';

describe('readableKey', () => {
  it('shortens imported source IDs', () => {
    const key = JSON.stringify([
      'source',
      'c',
      'location',
      '',
      'gid://shopify/Location/77',
    ]);

    expect(readableKey('location', key, 'Main store')).toBe(
      'Main store location 77',
    );
    expect(readableKey('sku', key.replace('location', 'sku'))).toBe('SKU 77');
  });

  it('keeps operator keys unchanged', () => {
    expect(readableKey('sku', 'ABC-1')).toBe('ABC-1');
    expect(readableKey('sku', '["other","x"]')).toBe('["other","x"]');
  });
});
