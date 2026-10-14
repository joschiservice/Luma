import type { TenantContext } from '@luma/identity';
import { describe, expect, it, vi } from 'vitest';

import type { ActivityPage, ActivityQuery } from '../domain/activity.js';
import { createActivityService, resolveActivityActors } from './activity.js';
import { testContext } from './tenant-context.fixture.js';

const reader = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const window = {
  from: '2026-10-01T00:00:00Z',
  to: '2026-10-02T00:00:00Z',
};

describe('activity actor filter', () => {
  it('resolves me to the reader and drops repeated values', () => {
    expect(resolveActivityActors(['me', reader, 'luma'], reader)).toEqual([
      reader,
      'luma',
    ]);
    expect(resolveActivityActors(undefined, reader)).toBeUndefined();
  });

  it('reads with me resolved for the refreshed reader', async () => {
    const list = vi.fn<
      (context: TenantContext, query: ActivityQuery) => Promise<ActivityPage>
    >(
      async () =>
        ({
          visibility: 'member',
          items: [],
          nextCursor: null,
          coverage: '',
        }) satisfies ActivityPage,
    );
    const context = testContext({ role: 'member', userId: reader });
    const read = createActivityService({ list }, async (value) => value);
    await read(context, { ...window, limit: 30, actor: ['me', other] });
    expect(list.mock.calls[0]?.[1].actor).toEqual([reader, other]);
  });

  it('never reaches the store without activity access', async () => {
    const list = vi.fn();
    const context = testContext({ permissions: [], userId: reader });
    const read = createActivityService({ list }, async (value) => value);
    await expect(
      read(context, { ...window, limit: 30, actor: ['me'] }),
    ).rejects.toThrow();
    expect(list).not.toHaveBeenCalled();
  });
});
