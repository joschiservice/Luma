import { beforeEach, describe, expect, it, vi } from 'vitest';

const user = {
  id: 'e9494387-2e72-456b-b741-8dc566dc8d9d',
  name: 'Customer',
  email: 'customer@example.test',
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe('regional staff directory', () => {
  it('uses the same fanout path for one cell and preserves the owning region', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const path = String(input);
      if (path.endsWith('/config'))
        return response({
          mode: 'local',
          providerId: null,
          regionalDirectoryEnabled: true,
          region: 'AU',
          regionalApiOrigins: {},
        });
      if (path.endsWith('/session'))
        return response({ user, permissions: ['staff.directory.read'] });

      return response({
        users: [user],
        workspaces: [],
        usersTruncated: false,
        workspacesTruncated: false,
      });
    });
    vi.stubGlobal('fetch', fetcher);
    const { initializeStaffRegions } = await import('./regions');
    await initializeStaffRegions();
    const { searchRegionalDirectory } = await import('./queries');
    const result = await searchRegionalDirectory('customer');
    expect(result.incomplete).toBe(false);
    expect(result.users[0]?.region).toBe('AU');
    expect(result.regions).toHaveLength(1);
  });

  it('keeps successful region results and labels unreachable and out-of-scope regions incomplete', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockImplementation(async (input) => {
        const path = String(input);
        if (path === '/api/v1/staff/config')
          return response({
            mode: 'local',
            providerId: null,
            regionalDirectoryEnabled: true,
            region: 'AU',
            regionalApiOrigins: {
              EU: 'https://eu.staff.example.test',
              US: 'https://us.staff.example.test',
            },
          });
        if (path.startsWith('https://eu.'))
          throw new TypeError('Network failure');
        if (path.startsWith('https://us.')) return response({}, 403);
        if (path.endsWith('/session'))
          return response({ user, permissions: ['staff.directory.read'] });

        return response({
          users: [user],
          workspaces: [],
          usersTruncated: false,
          workspacesTruncated: false,
        });
      }),
    );
    const { initializeStaffRegions } = await import('./regions');
    await initializeStaffRegions();
    const { searchRegionalDirectory } = await import('./queries');
    const result = await searchRegionalDirectory('customer');
    expect(result.incomplete).toBe(true);
    expect(result.users.map((row) => row.region)).toEqual(['AU']);
    expect(result.regions.map((row) => [row.region, row.status])).toEqual([
      ['AU', 'answered'],
      ['EU', 'unavailable'],
      ['US', 'access-required'],
    ]);
  });

  it('keeps the local path enabled and marks unreleased remote searches incomplete without sending customer queries', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const path = String(input);
      if (path.endsWith('/config'))
        return response({
          mode: 'local',
          providerId: null,
          region: 'AU',
          regionalDirectoryEnabled: false,
          regionalApiOrigins: { EU: 'https://eu.staff.example.test' },
        });
      if (path.endsWith('/session'))
        return response({ user, permissions: ['staff.directory.read'] });

      return response({
        users: [],
        workspaces: [],
        usersTruncated: false,
        workspacesTruncated: false,
      });
    });
    vi.stubGlobal('fetch', fetcher);
    const { initializeStaffRegions } = await import('./regions');
    await initializeStaffRegions();
    const { searchRegionalDirectory } = await import('./queries');
    const result = await searchRegionalDirectory('customer');
    expect(result.incomplete).toBe(true);
    expect(result.regions.map((row) => [row.region, row.status])).toEqual([
      ['AU', 'answered'],
      ['EU', 'rollout-disabled'],
    ]);
    expect(
      fetcher.mock.calls.some(([input]) =>
        String(input).startsWith('https://eu.'),
      ),
    ).toBe(false);
  });

  it('keeps an existing regional query bound while navigation selects another cell', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) =>
      String(input).endsWith('/config')
        ? response({
            mode: 'local',
            providerId: null,
            region: 'AU',
            regionalDirectoryEnabled: true,
            regionalApiOrigins: { EU: 'https://eu.staff.example.test' },
          })
        : response({ user, permissions: ['staff.directory.read'] }),
    );
    vi.stubGlobal('fetch', fetcher);
    const { initializeStaffRegions } = await import('./regions');
    await initializeStaffRegions('AU');
    const { sessionOptions } = await import('./queries');
    const options = sessionOptions();
    await initializeStaffRegions('EU');
    const { QueryClient } = await import('@tanstack/react-query');
    const client = new QueryClient();
    await client.fetchQuery(options);
    expect(options.queryKey).toEqual(['staff', 'session', 'AU']);
    expect(fetcher).toHaveBeenLastCalledWith(
      '/api/v1/staff/session',
      expect.any(Object),
    );
    client.clear();
  });

  it('routes private commands directly to the owning API with regional cookies', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        mode: 'local',
        providerId: null,
        regionalDirectoryEnabled: true,
        region: 'AU',
        regionalApiOrigins: { EU: 'https://eu.staff.example.test' },
      }),
    );
    vi.stubGlobal('fetch', fetcher);
    const { initializeStaffRegions, regionalFetch } = await import('./regions');
    await initializeStaffRegions('EU');
    await regionalFetch('EU')('/api/v1/staff/accounts/opaque-id/access', {
      method: 'POST',
      credentials: 'same-origin',
      body: '{"reason":"Support request"}',
    });
    expect(fetcher).toHaveBeenLastCalledWith(
      new URL(
        'https://eu.staff.example.test/v1/staff/accounts/opaque-id/access',
      ),
      expect.objectContaining({ credentials: 'include', method: 'POST' }),
    );
    await expect(initializeStaffRegions('US')).rejects.toThrow(
      'not configured',
    );
  });
});
