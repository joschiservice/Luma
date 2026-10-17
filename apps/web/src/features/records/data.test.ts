import { expect, it } from 'vitest';

import { ApiError } from '../../kit/identity/data';
import { recordListError, recordReturnPath, recordsSearch } from './data';

it('keeps record return links within the selected workspace', () => {
  expect(recordReturnPath('first', '/app/first/exceptions?view=active')).toBe(
    '/app/first/exceptions?view=active',
  );
  expect(recordReturnPath('first', '/app/first/../second/records')).toBeNull();
  expect(recordReturnPath('first', '/app/second/records')).toBeNull();
  expect(recordReturnPath('first', 'https://other.example/')).toBeNull();
});

it('keeps valid page positions in the URL and drops malformed ones', () => {
  expect(recordsSearch.parse({ q: 'tote', cursor: 'abc', page: '2' })).toEqual({
    q: 'tote',
    cursor: 'abc',
    page: 2,
  });
  expect(recordsSearch.parse({ cursor: '', page: '0' })).toEqual({ q: '' });
});

it('explains a page link that no longer matches the search', () => {
  const stale = new ApiError(400, {
    code: 'VALIDATION_ERROR',
    message:
      'This page link no longer matches the record search. Start from the first page.',
    requestId: 'req-1',
  });
  expect(recordListError(stale, { q: 'tote', cursor: 'abc' })).toEqual({
    kind: 'page',
    message:
      'This page link no longer matches the record search. Start from the first page.',
  });
  expect(recordListError(stale, { q: 'tote' })).toEqual({
    kind: 'unavailable',
  });
  expect(recordListError(new ApiError(404), { q: '' })).toEqual({
    kind: 'access',
  });
  expect(recordListError(undefined, { q: '' })).toBeUndefined();
});
