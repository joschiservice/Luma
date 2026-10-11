import { describe, expect, it } from 'vitest';

import { IdentityError } from '../identity/data';
import { parseAddresses } from './composer';
import {
  commandError,
  inboxFilters,
  inboxSearch,
  readFailure,
  uncertainOutcome,
} from './data';

describe('inbox data', () => {
  it('maps read failures to sign-in, access, missing and unavailable', () => {
    expect(readFailure(new IdentityError(401))).toBe('signin');
    expect(readFailure(new IdentityError(403))).toBe('access');
    expect(readFailure(new IdentityError(404))).toBe('missing');
    expect(readFailure(new IdentityError(503))).toBe('unavailable');
    expect(readFailure(new TypeError('fetch failed'))).toBe('unavailable');
    expect(readFailure(null)).toBeUndefined();
  });

  it('treats network and server failures as unknown outcomes that retry the same request', () => {
    expect(uncertainOutcome(new TypeError('fetch failed'))).toBe(true);
    expect(uncertainOutcome(new IdentityError(502))).toBe(true);
    expect(uncertainOutcome(new IdentityError(409))).toBe(false);
    expect(commandError(new IdentityError(500))).toMatch(/at most once/);
  });

  it('keeps valid URL state and drops invalid values', () => {
    const search = inboxSearch.parse({
      view: 'overdue',
      connectionId: 'not-a-uuid',
      q: '  PO-1 ',
      thread: 'bbbbbbbb-0000-4000-8000-000000000001',
    });
    expect(search.connectionId).toBeUndefined();
    expect(inboxFilters(search)).toEqual({
      view: 'overdue',
      connectionId: undefined,
      q: 'PO-1',
    });
    expect(inboxFilters(inboxSearch.parse({ view: 'bogus' })).view).toBe(
      'open',
    );
  });

  it('parses reply recipients and names the first invalid one', () => {
    expect(parseAddresses('A@Example.com, b@example.com;')).toEqual({
      ok: true,
      addresses: ['a@example.com', 'b@example.com'],
    });
    expect(parseAddresses('a@example.com, nope')).toEqual({
      ok: false,
      invalid: 'nope',
    });
    expect(parseAddresses('')).toEqual({ ok: true, addresses: [] });
  });
});
