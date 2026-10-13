import { describe, expect, it, vi } from 'vitest';

import { builtInMembership, makeTenantContext } from '../domain/context.js';
import { PermissionSet } from '../domain/roles.js';
import {
  createMorningBriefReader,
  morningBriefClock,
} from './morning-brief.js';

const context = makeTenantContext(
  { userId: 'member', sessionId: 'session' },
  {
    id: 'tenant',
    name: 'Workspace',
    slug: 'workspace',
    status: 'active',
    dataRegion: 'EU',
  },
  builtInMembership(
    { id: 'membership', userId: 'member', organizationId: 'tenant' },
    'owner',
  ),
  'request',
);
const start = new Date('2026-10-24T06:00:00Z');
const end = new Date('2026-10-25T07:00:00Z');

function fixture() {
  const readers = {
    origin: 'https://app.luma.example',
    decisions: vi.fn().mockResolvedValue({
      totalCount: 1,
      items: [{ id: 'case:1', title: 'Review stock correction' }],
      sources: [{ state: 'available' }],
    }),
    overview: vi.fn().mockResolvedValue({
      window: { start: start.toISOString(), end: end.toISOString() },
      activeCount: 2,
      verifiedResolutions: 1,
      verifiedCases: [{ id: 'verified-1', summary: 'Stock comparison passed' }],
    }),
    active: vi.fn().mockResolvedValue({
      items: [
        { id: 'executed-1', summary: 'Awaiting independent verification' },
      ],
    }),
  };

  return { readers, read: createMorningBriefReader(readers) };
}

describe('morning briefs', () => {
  it('uses the exact Home window and keeps executed but unverified cases ongoing', async () => {
    const { readers, read } = fixture();
    const brief = await read(context, end, start);
    expect(readers.overview).toHaveBeenCalledWith(context, end, start);
    expect(brief).toMatchObject({
      start: start.toISOString(),
      end: end.toISOString(),
      attention: 1,
      active: 2,
      verified: 1,
      partial: false,
    });
    expect(brief?.cases).toEqual([
      {
        label: 'Stock comparison passed',
        verified: true,
        link: 'https://app.luma.example/app/tenant/exceptions/verified-1/detail',
      },
      {
        label: 'Awaiting independent verification',
        verified: false,
        link: 'https://app.luma.example/app/tenant/exceptions/executed-1/detail',
      },
    ]);
    expect(brief?.decisions[0]?.link).toBe(
      'https://app.luma.example/app/tenant/needs-you?item=case%3A1',
    );
  });

  it('skips an empty complete snapshot but labels unavailable sources', async () => {
    const { readers, read } = fixture();
    readers.decisions.mockResolvedValue({
      totalCount: 0,
      items: [],
      sources: [{ state: 'available' }],
    });
    readers.overview.mockResolvedValue({
      window: { start: start.toISOString(), end: end.toISOString() },
      activeCount: 0,
      verifiedResolutions: 0,
    });
    readers.active.mockResolvedValue({ items: [] });
    expect(await read(context, end, start)).toBeNull();
    readers.decisions.mockResolvedValue({
      totalCount: 0,
      items: [],
      sources: [{ state: 'unavailable' }],
    });
    expect(await read(context, end, start)).toMatchObject({
      partial: true,
      verified: 0,
    });
  });

  it('withholds inaccessible issue figures and never asks their readers', async () => {
    const { readers, read } = fixture();
    const limited = {
      ...context,
      permissions: PermissionSet.forRole(context.actor.role, []),
    };
    // A custom role resolves no implicit built-in grants.
    const role = {
      id: 'custom',
      key: 'custom' as const,
      name: 'Limited',
      builtIn: false,
      revision: 1,
    };
    limited.permissions = PermissionSet.forRole(role, []);
    expect(await read(limited, end, start)).toMatchObject({
      active: null,
      verified: null,
      cases: [],
    });
    expect(readers.overview).not.toHaveBeenCalled();
    expect(readers.active).not.toHaveBeenCalled();
  });

  it('propagates a failed required read instead of inventing a zero', async () => {
    const { readers, read } = fixture();
    readers.overview.mockRejectedValue(new Error('Unavailable'));
    await expect(read(context, end, start)).rejects.toThrow('Unavailable');
  });

  it('uses one local day across a repeated DST hour and catches up after a skipped hour', () => {
    expect(
      morningBriefClock(new Date('2026-10-25T00:30:00Z'), 'Europe/Berlin'),
    ).toEqual({ day: '2026-10-25', time: '02:30' });
    expect(
      morningBriefClock(new Date('2026-10-25T01:30:00Z'), 'Europe/Berlin'),
    ).toEqual({ day: '2026-10-25', time: '02:30' });
    expect(
      morningBriefClock(new Date('2026-03-29T01:00:00Z'), 'Europe/Berlin'),
    ).toEqual({ day: '2026-03-29', time: '03:00' });
    expect(
      morningBriefClock(new Date('2026-10-12T16:00:00Z'), 'Asia/Tokyo'),
    ).toEqual({ day: '2026-10-13', time: '01:00' });
  });
});
