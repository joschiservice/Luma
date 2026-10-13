import { randomUUID } from 'node:crypto';

import type { TenantContext } from '@luma/identity';
import {
  builtInMembership,
  IdentityError,
  makeTenantContext,
} from '@luma/identity';
import type { ModelGateway } from '@luma/platform';
import { describe, expect, it } from 'vitest';

import type { ViewsStore } from '../application/views.js';
import { createViewsService } from '../application/views.js';
import type {
  AdaptiveViewInput,
  AdaptiveViewRevision,
  StoredAdaptiveView,
} from '../domain/views.js';
import { viewDraftModelSchema, viewsValidation } from './views-validation.js';

function context(
  tenantId: string = randomUUID(),
  userId: string = randomUUID(),
  role: 'owner' | 'admin' | 'member' = 'member',
): TenantContext {
  return makeTenantContext(
    { userId, sessionId: randomUUID() },
    {
      id: tenantId,
      name: 'Fixture',
      slug: 'fixture',
      dataRegion: 'EU',
      status: 'active',
    },
    builtInMembership(
      { id: randomUUID(), organizationId: tenantId, userId },
      role,
    ),
    randomUUID(),
  );
}

function fixture(
  options: {
    model?: ModelGateway;
    released?: boolean;
    refresh?: (value: TenantContext) => Promise<TenantContext>;
    locationId?: string;
  } = {},
) {
  const documents = new Map<string, StoredAdaptiveView>();
  const revisions = new Map<string, AdaptiveViewRevision[]>();
  const store: ViewsStore = {
    transaction: async (tenantId, operation) =>
      operation({
        list: async () =>
          [...documents.values()].filter(
            (value) => value.tenantId === tenantId,
          ),
        get: async (id) => {
          const value = documents.get(id);

          return value?.tenantId === tenantId ? value : null;
        },
        save: async (value, changedBy, expected) => {
          const current = documents.get(value.id);
          if (expected !== null && current?.revision !== expected)
            throw new IdentityError(409, 'CONFLICT', 'Revision changed');
          documents.set(value.id, structuredClone(value));
          revisions.set(value.id, [
            { ...structuredClone(value), changedBy },
            ...(revisions.get(value.id) ?? []),
          ]);
        },
        history: async (id) => ({
          items: revisions.get(id) ?? [],
          truncated: false,
        }),
      }),
  };
  const service = createViewsService({
    store,
    validation: viewsValidation,
    draftSchema: viewDraftModelSchema,
    refreshContext: options.refresh ?? (async (value) => value),
    released: async () => options.released ?? true,
    readers: {
      orders: {
        read: async () => ({
          items: [{ id: randomUUID(), displayNumber: '123', status: 'open' }],
          nextCursor: null,
          asOf: '2026-10-13T00:00:00Z',
        }),
      },
    },
    identities: async () => ({
      items: options.locationId
        ? [
            {
              kind: 'location' as const,
              id: options.locationId,
              label: 'German warehouse',
            },
          ]
        : [],
      complete: true,
    }),
    trace: (ctx) => ({
      traceId: 'trace',
      spanId: 'span',
      requestId: ctx.requestId,
    }),
    id: randomUUID,
    now: () => new Date('2026-10-13T00:00:00Z'),
    ...(options.model ? { model: options.model } : {}),
    validateRoles: async () => {},
  });
  const input = (): AdaptiveViewInput => ({
    commandId: randomUUID(),
    name: 'Open orders',
    description: '',
    sharing: { scope: 'private', roleIds: [] },
    query: viewsValidation.query({
      version: 1,
      domain: 'orders',
      filters: { status: 'open' },
      columns: ['displayNumber', 'status'],
    }),
    reviewed: true,
  });

  return { service, input, documents };
}

describe('reviewed saved views', () => {
  it('keeps private queries and revisions isolated from other people and tenants', async () => {
    const { service, input } = fixture();
    const owner = context();
    const saved = await service.create(owner, input());
    await expect(
      service.get(context(owner.tenantId), saved.id),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.get(context(), saved.id)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(
      service.history(context(owner.tenantId), saved.id),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect((await service.list(owner)).items).toHaveLength(1);
  });
  it('allows workspace reading but requires owner or manager to revise', async () => {
    const { service, input } = fixture();
    const owner = context();
    const form = {
      ...input(),
      sharing: { scope: 'workspace' as const, roleIds: [] },
    };
    const saved = await service.create(owner, form);
    const peer = context(owner.tenantId);
    expect((await service.get(peer, saved.id)).canEdit).toBe(false);
    await expect(
      service.update(peer, saved.id, {
        ...form,
        expectedRevision: 1,
        name: 'Changed',
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    const admin = context(owner.tenantId, randomUUID(), 'admin');
    expect(
      (
        await service.update(admin, saved.id, {
          ...form,
          expectedRevision: 1,
          name: 'Changed',
        })
      ).revision,
    ).toBe(2);
    await expect(
      service.update(owner, saved.id, { ...form, expectedRevision: 1 }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
  it('checks current role sharing and hides private history after visibility changes', async () => {
    const { service, input } = fixture();
    const owner = context();
    const form = input();
    const saved = await service.create(owner, form);
    const shared = await service.update(owner, saved.id, {
      ...form,
      sharing: { scope: 'roles', roleIds: ['member'] },
      expectedRevision: 1,
    });
    const peer = context(owner.tenantId);
    expect((await service.get(peer, saved.id)).revision).toBe(shared.revision);
    expect((await service.history(peer, saved.id)).items).toHaveLength(1);
  });
  it('replays creation with the same identity and rejects identity reuse for another query', async () => {
    const { service, input } = fixture();
    const owner = context();
    const form = input();
    const first = await service.create(owner, form);
    const replay = await service.create(owner, form);
    expect(replay.id).toBe(first.id);
    expect((await service.list(owner)).items).toHaveLength(1);
    await expect(
      service.create(owner, { ...form, name: 'Different' }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
  it('duplicates into a private view with a fresh stable identity', async () => {
    const { service, input } = fixture();
    const owner = context();
    const original = await service.create(owner, input());
    const copy = await service.duplicate(
      owner,
      original.id,
      'Copy',
      randomUUID(),
    );
    expect(copy.id).not.toBe(original.id);
    expect(copy.sharing.scope).toBe('private');
    expect(copy.query).toEqual(original.query);
  });
  it('fails closed after membership refresh, release disablement and unsupported predicates', async () => {
    const initial = context();
    const changed = context(initial.tenantId);
    await expect(
      fixture({ refresh: async () => changed }).service.list(initial),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      fixture({ released: false }).service.list(initial),
    ).rejects.toMatchObject({ statusCode: 404 });
    const { service, input } = fixture();
    await expect(
      service.preview(initial, {
        ...input().query,
        filters: { warehouseName: 'Germany' },
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });
  it('degrades removed display columns while refusing missing filter fields', async () => {
    const { service, input } = fixture();
    const ctx = context();
    const preview = await service.preview(ctx, {
      ...input().query,
      columns: ['displayNumber', 'custom:' + randomUUID()],
    });
    expect(preview.warnings).toHaveLength(1);
    expect(preview.items[0]).toHaveProperty('displayNumber');
    await expect(
      service.preview(ctx, {
        ...input().query,
        customFilters: [
          { fieldId: randomUUID(), operator: 'eq', value: 'yes' },
        ],
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });
  it('routes prompts through sensitive EU policy and returns unsaved clarification', async () => {
    let calls = 0;
    const model: ModelGateway = {
      generate: async (_ctx, request) => {
        calls++;
        expect(request.profile).toBe('authoring');
        expect(request.dataPolicy).toEqual({
          classification: 'sensitive',
          region: 'EU',
          zeroDataRetention: true,
        });
        const output =
          request.output?.parse({
            status: 'needs_clarification',
            query: null,
            explanation: 'Which warehouse? Stock delays need evidence.',
            warnings: [],
          }) ?? null;

        return {
          output,
          toolCalls: [],
          metadata: {
            adapter: 'bedrock-eu',
            model: 'fixture',
            inputTokens: 1,
            outputTokens: 1,
            costUsd: null,
            latencyMs: 1,
          },
        };
      },
    };
    const { service, documents } = fixture({ model });
    const draft = await service.generate(
      context(),
      'orders delayed by stock at my German warehouse',
    );
    expect(draft.status).toBe('needs_clarification');
    expect(draft.preview).toBeNull();
    expect(documents.size).toBe(0);
    expect(calls).toBe(1);
  });
  it('resolves the German warehouse example only to explicit fresh stock-hold predicates', async () => {
    const locationId = randomUUID();
    const model: ModelGateway = {
      generate: async (_context, request) => {
        expect(request.messages[0]?.content).toContain(locationId);
        const output =
          request.output?.parse({
            status: 'ready',
            query: viewsValidation.query({
              version: 1,
              domain: 'orders',
              filters: { locationId, stockBlocked: true },
              columns: ['displayNumber', 'status'],
            }),
            explanation:
              'Orders with an explicit fresh inventory-out-of-stock hold at German warehouse. Other stock delays remain unknown.',
            warnings: [],
          }) ?? null;

        return {
          output,
          toolCalls: [],
          metadata: {
            adapter: 'bedrock-eu',
            model: 'fixture',
            inputTokens: 1,
            outputTokens: 1,
            costUsd: null,
            latencyMs: 1,
          },
        };
      },
    };
    const { service, documents } = fixture({ model, locationId });
    const draft = await service.generate(
      context(),
      'orders delayed by stock at my German warehouse',
    );
    expect(draft.status).toBe('ready');
    expect(draft.query?.filters).toEqual({ locationId, stockBlocked: true });
    expect(
      draft.preview?.warnings.some((warning) =>
        warning.includes('Missing, stale or incomplete'),
      ),
    ).toBe(true);
    expect(documents.size).toBe(0);
  });
});
