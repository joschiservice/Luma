import { describe, expect, it } from 'vitest';

import { link } from './values.js';

describe('stored provider links', () => {
  it.each(['https://track.example/1Z', 'HTTP://carrier.example/?n=1'])(
    'keeps the web link %s',
    (value) => {
      expect(link(value)).toBe(value);
    },
  );

  it.each([
    'javascript:alert(1)',
    'data:text/html,hi',
    'https:track.example',
    '//track.example/1Z',
    'track.example/1Z',
    'https://',
    '',
    null,
    42,
  ])('drops %s', (value) => {
    expect(link(value)).toBeNull();
  });
});
