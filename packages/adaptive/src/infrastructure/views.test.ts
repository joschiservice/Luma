import { randomUUID } from 'node:crypto';

import type { TenantContext } from '@luma/identity';
import {
  builtInMembership,
  makeTenantContext,
  PermissionSet,
} from '@luma/identity';
import type { ModelGateway } from '@luma/platform';
import { conflict } from '@luma/platform';
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
  permissions?: string[],
): TenantContext {
  const membership = builtInMembership(
    { id: randomUUID(), organizationId: tenantId, userId },
    role,
  );

  return makeTenantContext(
    { userId, sessionId: randomUUID() },
    {
      id: tenantId,
      name: 'Fixture',
      slug: 'fixture',
      dataRegion: 'AU',
      status: 'active',
    },
    permissions
      ? { ...membership, permissions: new PermissionSet(permissions) }
      : membership,
    randomUUID(),
  );
}

/** A format 2 orders view showing number and status, with the given state changes. */
function ordersQuery(state: Record<string, unknown> = {}) {
  return viewsValidation.query({
    version: 2,
    domain: 'orders',
    state: {
      where: {
        match: 'all',
        conditions: [{ field: 'status', op: 'any_of', value: ['open'] }],
      },
      columns: [{ id: 'number' }, { id: 'status' }],
      ...state,
    },
    metrics: [],
    charts: [],
    actions: [],
  });
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
  const reads: Record<string, unknown>[] = [];
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
            throw conflict('Revision changed');
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
        read: async (_context, filters) => {
          reads.push(filters);

          return {
            items: [{ id: randomUUID(), displayNumber: '123', status: 'open' }],
            nextCursor: null,
            asOf: '2026-10-13T00:00:00Z',
          };
        },
      },
      returns: {
        read: async (_context, filters) => {
          reads.push(filters);

          return {
            items: [{ id: randomUUID(), name: '#1001-R1', stage: 'requested' }],
            nextCursor: null,
            asOf: '2026-10-13T00:00:00Z',
          };
        },
      },
      procurement: {
        read: async (_context, filters) => {
          reads.push(filters);

          return {
            items: [
              {
                id: randomUUID(),
                reference: 'PO-1',
                supplierName: 'Acme',
                stage: 'awaiting_confirmation',
                attentionKey: 'confirmation_overdue:1',
              },
            ],
            nextCursor: null,
            asOf: '2026-10-13T00:00:00Z',
          };
        },
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
    query: ordersQuery(),
    reviewed: true,
  });

  return { service, input, documents, reads };
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
    const owner = context(randomUUID(), randomUUID(), 'admin');
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
    const owner = context(randomUUID(), randomUUID(), 'admin');
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
  it('lets members keep personal views but requires view management to share', async () => {
    const { service, input } = fixture();
    const member = context();
    const form = input();
    await expect(
      service.create(member, {
        ...form,
        sharing: { scope: 'workspace', roleIds: [] },
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    const personal = await service.create(member, form);
    await expect(
      service.update(member, personal.id, {
        ...form,
        sharing: { scope: 'roles', roleIds: ['member'] },
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect((await service.list(context(member.tenantId))).items).toHaveLength(
      0,
    );
  });
  it('lets an owner without view management keep or narrow, but not widen, sharing', async () => {
    const { service, input } = fixture();
    const tenantId = randomUUID();
    const userId = randomUUID();
    const form = {
      ...input(),
      sharing: { scope: 'roles' as const, roleIds: ['member', 'admin'] },
    };
    const saved = await service.create(
      context(tenantId, userId, 'admin'),
      form,
    );
    const demoted = context(tenantId, userId, 'member');
    const kept = await service.update(demoted, saved.id, {
      ...form,
      name: 'Renamed',
      expectedRevision: 1,
    });
    const narrowed = await service.update(demoted, saved.id, {
      ...form,
      sharing: { scope: 'roles', roleIds: ['member'] },
      expectedRevision: kept.revision,
    });
    await expect(
      service.update(demoted, saved.id, {
        ...form,
        sharing: { scope: 'workspace', roleIds: [] },
        expectedRevision: narrowed.revision,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
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
    const { service } = fixture();
    await expect(
      service.preview(
        initial,
        viewsValidation.query({
          version: 1,
          domain: 'orders',
          filters: { warehouseName: 'Germany' },
          columns: ['displayNumber'],
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 422 });
  });
  it('degrades removed display columns while refusing missing filter fields', async () => {
    const { service, input } = fixture();
    const ctx = context();
    const preview = await service.preview(
      ctx,
      ordersQuery({
        columns: [{ id: 'number' }, { id: `custom:${randomUUID()}` }],
      }),
    );
    expect(preview.warnings).toHaveLength(1);
    expect(preview.items[0]).toHaveProperty('number', '123');
    await expect(
      service.preview(
        ctx,
        ordersQuery({
          where: {
            match: 'all',
            conditions: [
              { field: `custom:${randomUUID()}`, op: 'is', value: 'yes' },
            ],
          },
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 422 });
    expect(input().query.version).toBe(2);
  });
  it('routes prompts through sensitive tenant-region policy and returns unsaved clarification', async () => {
    let calls = 0;
    const model: ModelGateway = {
      generate: async (_ctx, request) => {
        calls++;
        expect(request.profile).toBe('authoring');
        expect(request.dataPolicy).toEqual({
          classification: 'sensitive',
          region: 'AU',
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
            adapter: 'bedrock',
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
            query: ordersQuery({
              where: {
                match: 'all',
                conditions: [
                  { field: 'warehouse', op: 'any_of', value: [locationId] },
                  { field: 'stockBlocked', op: 'is', value: true },
                ],
              },
            }),
            explanation:
              'Orders with an explicit fresh inventory-out-of-stock hold at German warehouse. Other stock delays remain unknown.',
            warnings: [],
          }) ?? null;

        return {
          output,
          toolCalls: [],
          metadata: {
            adapter: 'bedrock',
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
    expect(draft.query?.state.where.conditions).toEqual([
      { field: 'warehouse', op: 'any_of', value: [locationId] },
      { field: 'stockBlocked', op: 'is', value: true },
    ]);
    expect(
      draft.preview?.warnings.some((warning) =>
        warning.includes('Missing, stale or incomplete'),
      ),
    ).toBe(true);
    expect(documents.size).toBe(0);
  });
  it('upgrades format 1 input and stores and returns format 2', async () => {
    const { service, documents } = fixture();
    const owner = context();
    const saved = await service.create(owner, {
      commandId: randomUUID(),
      name: 'Legacy',
      description: '',
      sharing: { scope: 'private', roleIds: [] },
      query: {
        version: 1,
        domain: 'orders',
        filters: { view: 'overdue', status: 'open' },
        customFilters: [],
        columns: ['displayNumber', 'dueAt'],
        sort: { field: 'placed', direction: 'asc' },
        groupBy: null,
        layout: 'table',
        metrics: [],
        charts: [],
        actions: [],
      },
      reviewed: true,
    });
    expect(saved.query).toMatchObject({
      version: 2,
      state: {
        segment: 'overdue',
        where: { conditions: [{ field: 'status', value: ['open'] }] },
        columns: [{ id: 'number' }, { id: 'due' }],
        sort: { field: 'placed', direction: 'asc' },
      },
    });
    expect(documents.get(saved.id)?.query.version).toBe(2);
  });

  it('compiles a view for its reader and keys preview rows by catalog column', async () => {
    const { service, reads } = fixture();
    const preview = await service.preview(
      context(),
      ordersQuery({
        segment: 'stuck',
        sort: { field: 'placed', direction: 'asc' },
      }),
    );
    expect(reads[0]).toMatchObject({
      view: 'stuck',
      sort: 'placed',
      direction: 'asc',
      count: 'exact',
    });
    expect(JSON.parse(String(reads[0]?.where))).toEqual({
      match: 'all',
      conditions: [{ field: 'status', op: 'any_of', value: ['open'] }],
    });
    expect(Object.keys(preview.items[0] ?? {}).sort()).toEqual([
      'id',
      'number',
      'status',
    ]);
    expect(preview.availableColumns).toContain('number');
    expect(preview.availableColumns).not.toContain('displayNumber');
  });

  it('reads purchase orders like the Procurement page: built-in views as stage, conditions as where', async () => {
    const { service, reads } = fixture();
    const conditions = [
      {
        field: 'attention',
        op: 'any_of' as const,
        value: ['confirmation_overdue'],
      },
      { field: 'supplier', op: 'any_of' as const, value: [randomUUID()] },
    ];
    const query = (segment: string | null, match: 'all' | 'any' = 'all') =>
      viewsValidation.query({
        version: 2,
        domain: 'procurement',
        state: {
          segment,
          where: { match, conditions },
          sort: { field: 'expected', direction: 'asc' },
          columns: [{ id: 'supplier' }, { id: 'attention' }, { id: 'stage' }],
        },
        metrics: [],
        charts: [],
        actions: [],
      });
    const preview = await service.preview(
      context(randomUUID(), randomUUID(), 'admin'),
      query('awaiting_confirmation', 'any'),
    );
    expect(reads[0]).toEqual({
      stage: 'awaiting_confirmation',
      where: JSON.stringify({ match: 'any', conditions }),
      sort: 'expected',
      direction: 'asc',
      count: 'exact',
    });
    expect(preview.items[0]).toMatchObject({
      supplier: 'Acme',
      attention: 'confirmation_overdue:1',
      stage: 'awaiting_confirmation',
    });
    await service.preview(
      context(randomUUID(), randomUUID(), 'admin'),
      query('all'),
    );
    expect(reads[1]).not.toHaveProperty('stage');
    await expect(
      service.preview(
        context(randomUUID(), randomUUID(), 'admin'),
        query('received'),
      ),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it('keeps format 1 procurement views working as conditions', async () => {
    const { service, reads } = fixture();
    const preview = await service.preview(
      context(randomUUID(), randomUUID(), 'admin'),
      viewsValidation.query({
        version: 1,
        domain: 'procurement',
        filters: { attention: 'confirmation_overdue', status: 'open' },
        customFilters: [],
        columns: ['reference', 'supplierName', 'attentionKey'],
        sort: null,
        groupBy: null,
        layout: 'table',
        metrics: [],
        charts: [],
        actions: [],
      }),
    );
    expect(JSON.parse(String(reads[0]?.where)).conditions).toEqual(
      expect.arrayContaining([
        { field: 'attention', op: 'any_of', value: ['confirmation_overdue'] },
        { field: 'status', op: 'any_of', value: ['open'] },
      ]),
    );
    expect(preview.items[0]).toMatchObject({
      reference: 'PO-1',
      attention: 'confirmation_overdue:1',
    });
  });

  it('describes to the model only what the purchase-order reader runs', () => {
    const lists = viewsValidation.describe(
      ['procurement', 'issues'],
      new Set(['procurement.read', 'issues.read']),
    );
    // Issues run their catalog conditions natively, so no single-value owner filter remains.
    expect(lists.issues!.conditions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'owner',
          operators: ['any_of', 'none_of', 'empty', 'not_empty'],
          identities: 'members',
        }),
        expect.objectContaining({ field: 'class', type: 'enum' }),
      ]),
    );
    expect(lists.issues!.conditions.filter((item) => 'values' in item)).toEqual(
      [],
    );
    const procurement = lists.procurement!;
    expect(procurement.segments).toEqual([
      'all',
      'attention',
      'awaiting_confirmation',
      'draft',
    ]);
    expect(procurement.columns).toEqual(
      expect.arrayContaining(['stage', 'expected', 'nextOwner', 'value']),
    );
    expect(procurement.conditions.map((item) => item.field)).toEqual(
      expect.arrayContaining(['stage', 'attention', 'supplier', 'value']),
    );
    expect(procurement.sort).toEqual(
      expect.arrayContaining(['created', 'expected', 'value']),
    );
  });

  it('runs every return condition natively, including any-of matches', async () => {
    const { service, reads } = fixture();
    const conditions = [
      { field: 'stage', op: 'any_of' as const, value: ['requested'] },
      {
        field: 'value',
        op: 'gte' as const,
        value: { amount: '40', currency: 'EUR' },
      },
    ];
    const preview = await service.preview(
      context(randomUUID(), randomUUID(), 'admin'),
      viewsValidation.query({
        version: 2,
        domain: 'returns',
        state: {
          segment: 'action',
          where: { match: 'any', conditions },
          columns: [{ id: 'name' }, { id: 'stage' }],
        },
        metrics: [],
        charts: [],
        actions: [],
      }),
    );
    expect(reads[0]).toEqual({
      view: 'action',
      where: JSON.stringify({ match: 'any', conditions }),
    });
    expect(preview.items[0]).toMatchObject({
      name: '#1001-R1',
      stage: 'requested',
    });
  });

  it('refuses views that need repair and conditions the role cannot use', async () => {
    const { service, input } = fixture();
    const owner = context();
    await expect(
      service.create(owner, {
        ...input(),
        query: ordersQuery({
          where: {
            match: 'all',
            conditions: [{ field: 'number', op: 'is', value: '1' }],
          },
        }),
      }),
    ).rejects.toMatchObject({
      statusCode: 422,
      message: 'This view needs repair. number: This field cannot be filtered.',
    });
    await expect(
      service.preview(
        context(owner.tenantId, randomUUID(), 'member', ['orders.read']),
        ordersQuery({
          where: {
            match: 'all',
            conditions: [
              { field: 'customer', op: 'any_of', value: [randomUUID()] },
            ],
          },
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('saves views of lists the view engine cannot preview yet, without previewing them', async () => {
    const { service, input } = fixture();
    const owner = context(randomUUID(), randomUUID(), 'admin');
    const query = viewsValidation.query({
      version: 2,
      domain: 'inbox',
      state: { segment: 'review' },
      metrics: [],
      charts: [],
      actions: [],
    });
    const saved = await service.create(owner, { ...input(), query });
    expect(saved.query.domain).toBe('inbox');
    await expect(service.preview(owner, query)).rejects.toMatchObject({
      statusCode: 422,
    });
    await expect(
      service.create(owner, {
        ...input(),
        query: { ...query, state: { ...query.state, segment: 'nonexistent' } },
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });
});
