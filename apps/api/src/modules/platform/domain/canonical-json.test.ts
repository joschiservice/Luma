import { describe, expect, it } from 'vitest';

import { canonicalJson } from '#modules/platform/domain/canonical-json';

describe('canonical digest input', () => {
  it('sorts nested keys lexically while preserving array order', () => {
    expect(
      canonicalJson({ z: [{ b: 2, a: 1 }, 0], '2': 'two', '10': 'ten' }),
    ).toBe('{"10":"ten","2":"two","z":[{"a":1,"b":2},0]}');
    expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('preserves the existing digest representation of optional values', () => {
    expect(
      canonicalJson({
        missing: undefined,
        empty: null,
        values: [undefined, null],
      }),
    ).toBe('{"empty":null,"missing":undefined,"values":[,null]}');
  });

  it('escapes strings and leaves the supplied data unchanged', () => {
    const value = Object.freeze({
      text: 'a"b\n',
      nested: Object.freeze({ enabled: false }),
    });
    expect(canonicalJson(value)).toBe(
      '{"nested":{"enabled":false},"text":"a\\"b\\n"}',
    );
    expect(Object.keys(value)).toEqual(['text', 'nested']);
  });
});
