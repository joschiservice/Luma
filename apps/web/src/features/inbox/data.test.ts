import { collectionViewStateSchema, inboxCatalog } from '@luma/api-contract';
import { describe, expect, it } from 'vitest';

import { builtinState } from '../../kit/collections/state';
import { ApiError } from '../../kit/identity/data';
import { parseAddresses } from './composer';
import {
  commandError,
  hasLegacyFilters,
  inboxSearch,
  readFailure,
  threadListQuery,
  threadView,
  uncertainOutcome,
  withoutLegacyFilters,
} from './data';

describe('inbox data', () => {
  it('maps read failures to sign-in, access, missing and unavailable', () => {
    expect(readFailure(new ApiError(401))).toBe('signin');
    expect(readFailure(new ApiError(403))).toBe('access');
    expect(readFailure(new ApiError(404))).toBe('missing');
    expect(readFailure(new ApiError(503))).toBe('unavailable');
    expect(readFailure(new TypeError('fetch failed'))).toBe('unavailable');
    expect(readFailure(null)).toBeUndefined();
  });

  it('treats network and server failures as unknown outcomes that retry the same request', () => {
    expect(uncertainOutcome(new TypeError('fetch failed'))).toBe(true);
    expect(uncertainOutcome(new ApiError(502))).toBe(true);
    expect(uncertainOutcome(new ApiError(409))).toBe(false);
    expect(commandError(new ApiError(500))).toMatch(/at most once/);
  });

  it('keeps valid URL state, drops invalid values and sends the view', () => {
    const search = inboxSearch.parse({
      view: 'overdue',
      connectionId: 'not-a-uuid',
      q: '  PO-1 ',
      thread: 'bbbbbbbb-0000-4000-8000-000000000001',
    });
    expect(search.connectionId).toBeUndefined();
    expect(hasLegacyFilters(search)).toBe(false);
    expect(
      threadListQuery(builtinState(inboxCatalog, 'overdue'), search.q, 'UTC'),
    ).toEqual({
      view: 'overdue',
      q: 'PO-1',
      sort: 'activity',
      direction: 'desc',
      timeZone: 'UTC',
      limit: 50,
    });
    expect(threadView(inboxSearch.parse({ view: 'bogus' }).view)).toBe('open');
  });

  it('turns an older mailbox link into a condition and sends structured filters only', () => {
    const mailbox = 'bbbbbbbb-0000-4000-8000-000000000002';
    const legacy = inboxSearch.parse({ view: 'mine', connectionId: mailbox });
    expect(withoutLegacyFilters(legacy)).toEqual({
      view: 'mine',
      where: {
        match: 'all',
        conditions: [{ field: 'mailbox', op: 'any_of', value: [mailbox] }],
      },
    });
    const state = collectionViewStateSchema.parse({
      ...builtinState(inboxCatalog, 'open'),
      where: {
        match: 'all',
        conditions: [{ field: 'hasAttachments', op: 'is', value: true }],
      },
      sort: { field: 'due', direction: 'asc' },
      group: { field: 'mailbox' },
    });
    expect(threadListQuery(state, undefined, 'UTC')).toMatchObject({
      where: JSON.stringify(state.where),
      sort: 'due',
      direction: 'asc',
      group: 'mailbox',
      groupLimit: 10,
    });
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
