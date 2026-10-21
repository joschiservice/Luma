import { expect, it } from 'vitest';

import { readChangeCursor, writeChangeCursor } from './changes.js';

it('round-trips positions beyond JavaScript’s safe integers', () => {
  const position = { xact: '18446744073709551615', id: '9223372036854775807' };

  expect(readChangeCursor(writeChangeCursor(position))).toEqual(position);
});

it('rejects cursors it did not write', () => {
  for (const cursor of [
    'not-a-cursor',
    Buffer.from('12:').toString('base64url'),
    Buffer.from('012:3').toString('base64url'),
    Buffer.from('-1:3').toString('base64url'),
    Buffer.from('1:2:3').toString('base64url'),
  ])
    expect(readChangeCursor(cursor)).toBeNull();
});
