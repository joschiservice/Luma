import { expect, it } from 'vitest';

import { recordReturnPath } from './data';

it('keeps record return links within the selected workspace', () => {
  expect(recordReturnPath('first', '/app/first/exceptions?view=active')).toBe(
    '/app/first/exceptions?view=active',
  );
  expect(recordReturnPath('first', '/app/first/../second/records')).toBeNull();
  expect(recordReturnPath('first', '/app/second/records')).toBeNull();
  expect(recordReturnPath('first', 'https://other.example/')).toBeNull();
});
