import { describe, expect, it, vi } from 'vitest';

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
