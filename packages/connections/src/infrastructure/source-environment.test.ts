import { randomUUID } from 'node:crypto';

import { builtInMembership, makeTenantContext } from '@luma/identity';
import { expect, it, vi } from 'vitest';

import {
  createSourceEnvironments,
  type SourceEnvironmentRepository,
} from '../application/source-environment.js';
import type { InstalledConnection } from '../domain/installation.js';
import type {
  SourceEnvironmentDeclaration,
  SourceEnvironmentReview,
} from '../domain/source-environment.js';

const tenantId = randomUUID(),
  userId = randomUUID();
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

function fixture() {
  let c: InstalledConnection = {
    id: randomUUID(),
    tenantId,
    label: 'Supplier source',
    target: { kind: 'jtl-cloud', endpoint: 'https://example.test' },
    provider: 'jtl',
    status: 'active',
    permissions: ['purchase-orders.read'],
    granted: ['purchase-orders.read'],
    version: 1,
    credentialVersion: 1,
    createdAt: '2026-10-13T12:00:00Z',
    updatedAt: '2026-10-13T12:00:00Z',
  };
  let declaration: SourceEnvironmentDeclaration | null = null;
  const reviews = new Map<string, SourceEnvironmentReview>();
  let time = Date.parse('2026-10-13T12:00:00Z'),
    synthetic = false,
    installed = true;
  const readEvidence = vi.fn<
    () => Promise<SourceEnvironmentReview['observations']>
  >(async () => [
    {
      id: 'observation',
      provider: 'jtl',
      resource: 'purchase_order',
      sourceRevision: 'rev-1',
      observedAt: new Date(time).toISOString(),
    },
  ]);
  const retain = vi.fn(
    async (_tenantId: string, review: SourceEnvironmentReview) => {
      reviews.set(review.id, review);
    },
  );
  const repository: SourceEnvironmentRepository = {
    declaration: async () => declaration,
    review: async (_, id) => reviews.get(id) ?? null,
    retain,
    change: async (_ctx, _id, _command, _fingerprint, apply) => {
      declaration = await apply(declaration, c);

      return declaration;
    },
  };
  const service = createSourceEnvironments({
    repository,
    refreshContext: async (c) => c,
    connections: { list: async () => [c] },
    enabled: async () => true,
    synthetic: () => synthetic,
    installed: async () => installed,
    readEvidence,
    binding: (c) =>
      JSON.stringify([
        c.tenantId,
        c.id,
        c.version,
        c.credentialVersion,
        c.target,
      ]),
    fingerprint: JSON.stringify,
    id: randomUUID,
    now: () => new Date(time),
  });

  return {
    service,
    readEvidence,
    retain,
    get connection() {
      return c;
    },
    rotate() {
      c = {
        ...c,
        version: c.version + 1,
        credentialVersion: c.credentialVersion + 1,
      };
    },
    sourceChange() {
      c = { ...c, target: { ...c.target, endpoint: 'https://changed.test' } };
    },
    synthetic() {
      synthetic = true;
    },
    uninstall() {
      installed = false;
    },
    advance() {
      time += 300_001;
    },
  };
}

const command = (reviewId: string | null) => ({
  commandId: randomUUID(),
  expectedRevision: 0,
  reviewId,
  liveOperationsConfirmed: reviewId !== null,
  reason: 'Reviewed operational use',
});

it('requires a fresh actor-bound review, retains exact proof, and never infers live from an authenticated read', async () => {
  const f = fixture();
  expect((await f.service.classify(context, f.connection.id)).environment).toBe(
    'unknown',
  );
  const review = await f.service.inspect(context, f.connection.id);
  expect((await f.service.classify(context, f.connection.id)).environment).toBe(
    'unknown',
  );
  await f.service.change(context, f.connection.id, command(review.id));
  expect(await f.service.classify(context, f.connection.id)).toMatchObject({
    environment: 'live',
    provenance: {
      basis: 'reviewed_workspace_declaration',
      connectionId: f.connection.id,
      credentialVersion: 1,
      declarationRevision: 1,
      evidenceId: review.id,
    },
  });
  f.rotate();
  expect((await f.service.classify(context, f.connection.id)).environment).toBe(
    'unknown',
  );
  await expect(
    f.service.change(context, f.connection.id, command(review.id)),
  ).rejects.toMatchObject({ statusCode: 409 });
});

it('fails closed on expired reviews, changed source identity and app removal, with a positive simulator override', async () => {
  for (const invalidate of ['advance', 'sourceChange', 'uninstall'] as const) {
    const f = fixture(),
      review = await f.service.inspect(context, f.connection.id);
    f[invalidate]();
    await expect(
      f.service.change(context, f.connection.id, command(review.id)),
    ).rejects.toMatchObject({ statusCode: 409 });
  }
  const f = fixture(),
    review = await f.service.inspect(context, f.connection.id);
  await f.service.change(context, f.connection.id, command(review.id));
  f.synthetic();
  expect((await f.service.classify(context, f.connection.id)).environment).toBe(
    'synthetic',
  );
  await expect(
    f.service.inspect(context, f.connection.id),
  ).rejects.toMatchObject({ statusCode: 409 });
  await f.service.change(context, f.connection.id, {
    ...command(null),
    expectedRevision: 1,
  });
  expect((await f.service.classify(context, f.connection.id)).environment).toBe(
    'synthetic',
  );
});

it('requires current connection-management authority and never retains unavailable source evidence', async () => {
  const f = fixture();
  const member = makeTenantContext(
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
      'member',
    ),
    randomUUID(),
  );
  await expect(
    f.service.inspect(member, f.connection.id),
  ).rejects.toMatchObject({ statusCode: 403 });
  expect(f.readEvidence).not.toHaveBeenCalled();
  f.readEvidence.mockResolvedValueOnce([]);
  await expect(
    f.service.inspect(context, f.connection.id),
  ).rejects.toMatchObject({ statusCode: 409 });
});

it('rejects another actor’s review and a revoked declaration retains its original audited evidence', async () => {
  const f = fixture(),
    review = await f.service.inspect(context, f.connection.id);
  const otherId = randomUUID();
  const other = makeTenantContext(
    { userId: otherId, sessionId: randomUUID() },
    {
      id: tenantId,
      name: 'Workspace',
      slug: 'workspace',
      status: 'active',
      dataRegion: 'EU',
    },
    builtInMembership(
      { id: randomUUID(), organizationId: tenantId, userId: otherId },
      'owner',
    ),
    randomUUID(),
  );
  await expect(
    f.service.change(other, f.connection.id, command(review.id)),
  ).rejects.toMatchObject({ statusCode: 409 });
  const before = await f.service.change(
    context,
    f.connection.id,
    command(review.id),
  );
  await f.service.change(context, f.connection.id, {
    ...command(null),
    expectedRevision: 1,
  });
  expect((await f.service.classify(context, f.connection.id)).environment).toBe(
    'unknown',
  );
  expect(before).toMatchObject({
    revoked: false,
    review: { id: review.id, actorId: userId },
  });
});

it('cancels a caller-aborted inspection without retaining late evidence', async () => {
  const f = fixture(),
    controller = new AbortController();
  let complete:
    | ((
        value: {
          id: string;
          provider: string;
          resource: string;
          sourceRevision: string | null;
          observedAt: string;
        }[],
      ) => void)
    | undefined;
  f.readEvidence.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const inspection = f.service.inspect(
    context,
    f.connection.id,
    controller.signal,
  );
  await vi.waitFor(() => expect(f.readEvidence).toHaveBeenCalledOnce());
  controller.abort();
  await expect(inspection).rejects.toMatchObject({ statusCode: 503 });
  complete?.([
    {
      id: 'late',
      provider: 'jtl',
      resource: 'purchase_order',
      sourceRevision: null,
      observedAt: '2026-10-13T12:00:00Z',
    },
  ]);
  await Promise.resolve();
  expect(f.retain).not.toHaveBeenCalled();
});

it('lists authoritative unavailable-review reasons and applies the same denial before any provider call', async () => {
  for (const reason of [
    'synthetic',
    'inactive',
    'missing_capability',
    'app_unavailable',
  ] as const) {
    const f = fixture();
    if (reason === 'synthetic') f.synthetic();
    if (reason === 'inactive') f.connection.status = 'disconnected';
    if (reason === 'missing_capability') f.connection.granted = [];
    if (reason === 'app_unavailable') f.uninstall();
    expect((await f.service.list(context)).items[0]).toMatchObject({
      reviewable: false,
      reviewBlock: reason,
    });
    await expect(
      f.service.inspect(context, f.connection.id),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(f.readEvidence).not.toHaveBeenCalled();
  }
  const f = fixture();
  expect((await f.service.list(context)).items[0]).toMatchObject({
    reviewable: true,
    reviewBlock: null,
  });
});
