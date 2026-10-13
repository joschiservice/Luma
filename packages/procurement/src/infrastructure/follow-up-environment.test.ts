import { randomUUID } from 'node:crypto';

import { builtInMembership, makeTenantContext } from '@luma/identity';
import { expect, it, vi } from 'vitest';

import { createFollowUpEnvironmentReader } from '../application/follow-up-environment.js';

const tenantId = randomUUID(),
  userId = randomUUID(),
  connectionId = randomUUID();
const context = makeTenantContext(
  { userId, sessionId: randomUUID() },
  {
    id: tenantId,
    name: 'Workspace',
    slug: 'workspace',
    status: 'active',
    dataRegion: 'EU',
  },
  builtInMembership(
    { id: randomUUID(), organizationId: tenantId, userId },
    'owner',
  ),
  randomUUID(),
);
const view = {
  supplier: { link: { connectionId } },
  submission: {
    state: 'submitted' as const,
    connectionId,
    externalOrder: { externalId: 'PO-1', orderNumber: null },
  },
};

it('classifies synthetic only from positive trusted proof for the submitted order’s matching owner connection', async () => {
  const classify = vi.fn(async () => ({
    environment: 'synthetic' as const,
    provenance: null,
  }));
  const read = createFollowUpEnvironmentReader({
    commitments: { order: async () => view },
    connectionEnvironment: classify,
  });
  expect(await read(context, 'order')).toEqual({
    environment: 'synthetic',
    provenance: null,
  });
  expect(classify).toHaveBeenCalledWith(context, connectionId);
  expect(
    await createFollowUpEnvironmentReader({
      commitments: { order: async () => view },
      connectionEnvironment: async () => ({
        environment: 'unknown' as const,
        provenance: null,
      }),
    })(context, 'order'),
  ).toEqual({ environment: 'unknown', provenance: null });
});

it('keeps local, unsent, missing and contradictory bindings unknown without requesting classification', async () => {
  const classify = vi.fn(async () => ({
    environment: 'synthetic' as const,
    provenance: null,
  }));
  for (const changed of [
    { ...view, supplier: null },
    { ...view, submission: null },
    { ...view, submission: { ...view.submission, state: 'failed' as const } },
    { ...view, submission: { ...view.submission, externalOrder: null } },
    { ...view, submission: { ...view.submission, connectionId: randomUUID() } },
  ]) {
    const read = createFollowUpEnvironmentReader({
      commitments: { order: async () => changed },
      connectionEnvironment: classify,
    });
    expect(await read(context, 'order')).toEqual({
      environment: 'unknown',
      provenance: null,
    });
  }
  expect(classify).not.toHaveBeenCalled();
});
