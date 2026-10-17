import { afterEach, describe, expect, it, vi } from 'vitest';

import { createStaffActivityTracker } from './activity';
import { createStaffApi, StaffApiError } from './api';

const workspaceId = 'f9834020-2998-4822-9bcb-077a9f560dc7';
const userId = 'e9494387-2e72-456b-b741-8dc566dc8d9d';
const grantId = '8ad9eb76-f127-4ff6-9c40-5fab48dd450c';
const commandId = 'cf19d77b-2f9d-43e0-9b27-af37e9bbecb4';

function fetchResult(body: unknown, status = 200) {
  return vi.fn<typeof fetch>().mockImplementation(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('staff browser API', () => {
  it('keeps credentials on the same origin and bypasses private response caches', async () => {
    const fetcher = fetchResult({
      usersTruncated: false,
      workspacesTruncated: false,
      users: [],
      workspaces: [],
    });
    await createStaffApi(fetcher).directory('alice@example.com');
    expect(fetcher).toHaveBeenCalledWith(
      '/api/v1/staff/directory?query=alice%40example.com',
      expect.objectContaining({
        credentials: 'same-origin',
        cache: 'no-store',
        method: 'GET',
      }),
    );
  });

  it('uses the isolated auth bridge and keeps the password out of the URL', async () => {
    const fetcher = fetchResult({ user: {}, token: 'not-stored' });
    await createStaffApi(fetcher).signIn(
      'staff@example.com',
      'development-password',
    );
    expect(fetcher).toHaveBeenCalledWith(
      '/api/auth/sign-in/email',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          email: 'staff@example.com',
          password: 'development-password',
        }),
      }),
    );
  });

  it('retains the supplied command identity and explicit account-wide acknowledgement', async () => {
    const completedAt = '2026-10-08T12:00:00.000Z';
    const fetcher = fetchResult({ commandId, revokedSessions: 3, completedAt });
    const api = createStaffApi(fetcher);
    const body = {
      grantId,
      commandId,
      reason: 'Customer requested account-wide sign-out',
      acknowledgeGlobalEffect: true as const,
    };
    await api.revokeSessions(workspaceId, userId, body);
    await api.revokeSessions(workspaceId, userId, body);
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      `/api/v1/staff/workspaces/${workspaceId}/users/${userId}/revoke-sessions`,
      expect.objectContaining({ body: JSON.stringify(body) }),
    );
  });

  it('sends membership commands with their command ID and shows the server’s conflict reason', async () => {
    const completedAt = '2026-10-10T12:00:00.000Z';
    const fetcher = fetchResult({
      commandId,
      membershipId: userId,
      status: 'suspended',
      lastActiveOwner: true,
      completedAt,
    });
    const body = {
      grantId,
      commandId,
      reason: 'Departed employee, owner unreachable',
      acknowledgeLastOwner: true,
    };
    await createStaffApi(fetcher).changeMembership(
      workspaceId,
      userId,
      'suspend',
      body,
    );
    expect(fetcher).toHaveBeenCalledWith(
      `/api/v1/staff/workspaces/${workspaceId}/users/${userId}/suspend-membership`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify(body) }),
    );
    const conflict = fetchResult(
      { code: 'CONFLICT', message: 'This membership is already active.' },
      409,
    );
    await expect(
      createStaffApi(conflict).changeMembership(
        workspaceId,
        userId,
        'reactivate',
        { grantId, commandId, reason: 'Access dispute resolved' },
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: 'This membership is already active.',
    });
  });

  it('requests inspection, reads the latest request and opens access under it', async () => {
    const request = {
      id: commandId,
      mode: 'consent',
      status: 'approved',
      requestedAt: '2026-10-10T12:00:00.000Z',
      expiresAt: '2026-10-11T12:00:00.000Z',
      decidedAt: '2026-10-10T12:05:00.000Z',
      accessExpiresAt: '2026-10-10T12:35:00.000Z',
      revokedAt: null,
    };
    const requested = fetchResult(request);
    await createStaffApi(requested).requestAccess(
      workspaceId,
      'Ticket 4821: sync stopped',
    );
    expect(requested).toHaveBeenCalledWith(
      `/api/v1/staff/workspaces/${workspaceId}/access-requests`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ reason: 'Ticket 4821: sync stopped' }),
      }),
    );
    const latest = fetchResult({ request });
    expect(await createStaffApi(latest).accountAccessRequest(userId)).toEqual(
      request,
    );
    expect(latest).toHaveBeenCalledWith(
      `/api/v1/staff/accounts/${userId}/access-requests/latest`,
      expect.objectContaining({ method: 'GET' }),
    );
    expect(
      await createStaffApi(fetchResult({ request: null })).accessRequest(
        workspaceId,
      ),
    ).toBeNull();
    const opened = fetchResult({
      id: grantId,
      workspaceId,
      reason: 'Ticket 4821: sync stopped',
      expiresAt: request.accessExpiresAt,
    });
    await createStaffApi(opened).openAccess(workspaceId, {
      requestId: commandId,
    });
    expect(opened).toHaveBeenCalledWith(
      `/api/v1/staff/workspaces/${workspaceId}/access`,
      expect.objectContaining({
        body: JSON.stringify({ requestId: commandId }),
      }),
    );
  });

  it('passes the access history cursor and grant without retaining them elsewhere', async () => {
    const cursor = `2026-10-09T08:00:00.123456Z_${grantId}`;
    const fetcher = fetchResult({ events: [], nextCursor: null });
    await createStaffApi(fetcher).accessHistory(workspaceId, grantId, cursor);
    expect(fetcher).toHaveBeenCalledWith(
      `/api/v1/staff/workspaces/${workspaceId}/access-history?grantId=${grantId}&cursor=${encodeURIComponent(cursor)}`,
      expect.objectContaining({ method: 'GET', cache: 'no-store' }),
    );
  });

  it('sends only the audit filters that are set', async () => {
    const fetcher = fetchResult({ entries: [], nextCursor: null });
    await createStaffApi(fetcher).audit(
      { staff: 'support@example.test', event: 'staff.signed-in' },
      null,
    );
    expect(fetcher).toHaveBeenCalledWith(
      '/api/v1/staff/audit?staff=support%40example.test&event=staff.signed-in',
      expect.objectContaining({ method: 'GET', cache: 'no-store' }),
    );
  });

  it('rejects malformed successful responses at the contract boundary', async () => {
    await expect(
      createStaffApi(
        fetchResult({
          users: [{ email: 'customer@example.com' }],
          workspaces: [],
        }),
      ).directory('customer'),
    ).rejects.toThrow();
  });

  it('reports access loss without displaying backend diagnostics', async () => {
    const api = createStaffApi(
      fetchResult({ message: 'Database secret and private diagnostics' }, 403),
    );
    await expect(api.session()).rejects.toMatchObject({ status: 403 });
    await expect(api.session()).rejects.not.toThrow('Database secret');
  });

  it('preserves bounded read cancellation', async () => {
    const controller = new AbortController();
    const error = new DOMException('Read cancelled', 'AbortError');
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(error);
    await expect(
      createStaffApi(fetcher).session(controller.signal),
    ).rejects.toBe(error);
  });

  it('distinguishes an unavailable service from an empty successful result', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(
      createStaffApi(fetcher).directory('customer'),
    ).rejects.toBeInstanceOf(StaffApiError);
    await expect(
      createStaffApi(fetcher).directory('customer'),
    ).rejects.toMatchObject({ status: 0 });
  });
});

describe('staff authentication and activity boundaries', () => {
  const session = {
    user: {
      id: userId,
      name: 'Support operator',
      email: 'support@example.test',
    },
    permissions: ['staff.directory.read'],
  };

  it('reports real activity on one private request, then leaves passive polls read-only', async () => {
    const tracker = createStaffActivityTracker();
    const fetcher = fetchResult(session);
    const api = createStaffApi(fetcher, tracker);
    tracker.record({ isTrusted: true });
    await api.session();
    await api.session();
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      '/api/v1/staff/session',
      expect.objectContaining({ headers: { 'x-luma-staff-activity': 'true' } }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      '/api/v1/staff/session',
      expect.objectContaining({ headers: {} }),
    );
  });

  it('does not consume activity or attach activity reports to public configuration or auth', async () => {
    const tracker = createStaffActivityTracker();
    const fetcher = fetchResult({
      mode: 'local',
      providerId: null,
      regionalDirectoryEnabled: true,
      region: 'AU',
      regionalApiOrigins: {},
    });
    const api = createStaffApi(fetcher, tracker);
    tracker.record({ isTrusted: true });
    await api.config();
    await api.signIn('support@example.test', 'local-development-password');
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      '/api/v1/staff/config',
      expect.objectContaining({ headers: {} }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      '/api/auth/sign-in/email',
      expect.objectContaining({
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(tracker.consume()).toBe(true);
  });

  it('returns rejected Google callbacks to the same-origin staff login with sanitized failure state', async () => {
    const assign = vi.fn();
    vi.stubGlobal('window', {
      location: { origin: 'https://staff.example.test', assign },
    });
    const fetcher = fetchResult({
      url: 'https://accounts.google.com/o/oauth2/v2/auth?state=opaque',
    });
    await createStaffApi(fetcher).google();
    expect(fetcher).toHaveBeenCalledWith(
      '/api/auth/sign-in/social',
      expect.objectContaining({
        body: JSON.stringify({
          provider: 'google',
          callbackURL: 'https://staff.example.test/?region=AU',
          errorCallbackURL:
            'https://staff.example.test/login?signInFailed=true&region=AU',
        }),
      }),
    );
    expect(assign).toHaveBeenCalledWith(
      'https://accounts.google.com/o/oauth2/v2/auth?state=opaque',
    );
  });
});
