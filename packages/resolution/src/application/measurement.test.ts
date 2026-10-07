import { expect, it, vi } from 'vitest';

import type { MeasurementStore } from './measurement.js';
import { createMeasurementService } from './measurement.js';
import { testContext } from './tenant-context.fixture.js';

const tenant = '00000000-0000-4000-8000-000000000001';

function context(
  role: 'owner' | 'member' = 'owner',
  userId = 'operator',
  tenantId = tenant,
) {
  return testContext({ role, userId, tenantId });
}

it.each(['role', 'actor', 'tenant'] as const)(
  'rejects refreshed %s changes before recording or exposing evidence',
  async (change) => {
    const store: MeasurementStore = { append: vi.fn(), history: vi.fn() };
    const refreshContext = vi.fn(async () =>
      change === 'role'
        ? context('member')
        : change === 'actor'
          ? context('owner', 'other')
          : context(
              'owner',
              'operator',
              '00000000-0000-4000-8000-000000000002',
            ),
    );
    const service = createMeasurementService({
      store,
      refreshContext,
      parse: () => {
        throw new Error('Storage must not be reached');
      },
    });
    await expect(service.append(context(), 'incident', {})).rejects.toThrow();
    expect(store.append).not.toHaveBeenCalled();
    if (change !== 'role') {
      await expect(service.history(context(), 'incident', 0)).rejects.toThrow();
      expect(store.history).not.toHaveBeenCalled();
    }
  },
);
