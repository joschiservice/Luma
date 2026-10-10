import { builtInMembership, makeTenantContext } from '@luma/identity';
import { expect, it, vi } from 'vitest';

import type { AuthorityRepository } from './authority.js';
import { createAuthorityService } from './authority.js';

const context = (role: 'owner' | 'member') => {
  const tenantId = crypto.randomUUID();

  return makeTenantContext(
    { userId: 'operator', sessionId: 'session' },
    {
      id: tenantId,
      name: 'Store',
      slug: 'store',
      dataRegion: 'EU',
      status: 'active',
    },
    builtInMembership(
      { id: 'member', organizationId: tenantId, userId: 'operator' },
      role,
    ),
    crypto.randomUUID(),
  );
};

it('rechecks settings permission before changing authority', async () => {
  const actor = context('owner');
  const repository: AuthorityRepository = {
    read: vi.fn(),
    change: vi.fn(),
    history: vi.fn(),
  };
  const service = createAuthorityService(repository, async (value) => ({
    ...context('member'),
    tenantId: value.tenantId,
  }));

  await expect(
    service.change(actor, {
      commandId: crypto.randomUUID(),
      revision: 0,
      group: 'order_lines',
      connectionId: crypto.randomUUID(),
    }),
  ).rejects.toMatchObject({ statusCode: 403 });
  expect(repository.change).not.toHaveBeenCalled();
});

it('rejects refreshes to a different tenant or actor', async () => {
  const actor = context('owner');
  const repository: AuthorityRepository = {
    read: vi.fn(),
    change: vi.fn(),
    history: vi.fn(),
  };
  for (const fresh of [
    context('owner'),
    { ...actor, actor: { ...actor.actor, id: 'another' } },
  ]) {
    const service = createAuthorityService(repository, async () => fresh);
    await expect(
      service.change(actor, {
        commandId: crypto.randomUUID(),
        revision: 0,
        group: 'order_lines',
        connectionId: null,
      }),
    ).rejects.toBeDefined();
  }
  expect(repository.change).not.toHaveBeenCalled();
});
