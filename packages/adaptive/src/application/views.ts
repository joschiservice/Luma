import type { TenantContext } from '@luma/identity';
import {
  hasPermission,
  IdentityError,
  requireChangesAllowed,
  requirePermission,
  requireTenant,
} from '@luma/identity';
import type { ModelGateway, ModelSchema, TraceContext } from '@luma/platform';
import {
  authoringModelProfile,
  canonicalJson,
  ModelGatewayError,
} from '@luma/platform';

import type {
  AdaptiveView,
  AdaptiveViewDomain,
  AdaptiveViewDraft,
  AdaptiveViewInput,
  AdaptiveViewPreview,
  AdaptiveViewQuery,
  StoredAdaptiveView,
  ViewHistory,
} from '../domain/views.js';
import { builtInViews, viewColumns, viewPermissions } from '../domain/views.js';

export interface ViewsTransaction {
  list(): Promise<StoredAdaptiveView[]>;
  get(id: string): Promise<StoredAdaptiveView | null>;
  save(
    view: StoredAdaptiveView,
    changedBy: string,
    expectedRevision: number | null,
  ): Promise<void>;
  history(id: string): Promise<ViewHistory>;
}

export interface ViewsStore {
  /** Runs saved-query writes and immutable revision history in one tenant transaction. */
  transaction<T>(
    tenantId: string,
    operation: (tx: ViewsTransaction) => Promise<T>,
  ): Promise<T>;
}

export interface ViewReadResult {
  items: Record<string, unknown>[];
  nextCursor: string | null;
  asOf: string;
  totalCount?: number | null;
  warnings?: string[];
  aggregates?: AdaptiveViewPreview['aggregates'];
  groups?: AdaptiveViewPreview['groups'];
  chartSeries?: AdaptiveViewPreview['chartSeries'];
}

export interface ViewReadAdapter {
  /** Filter and sort in the owner before pagination; never filter a returned page. */
  read(
    context: TenantContext,
    filters: Record<string, unknown>,
    query: AdaptiveViewQuery,
    selectedRecordIds?: readonly string[],
  ): Promise<ViewReadResult>;
  /** Explicitly enabled only by an adapter that combines custom predicates before pagination. */
  supportsCustomQueries?: boolean;
  /** Explicitly enabled only when grouping/aggregation covers the whole filtered query. */
  supportsAggregates?: boolean;
  columns?: readonly string[];
}

export interface ViewsDependencies {
  store: ViewsStore;
  validation: {
    query(value: unknown): AdaptiveViewQuery;
    input(value: unknown): AdaptiveViewInput;
    preview(value: unknown): AdaptiveViewPreview;
    prompt(value: unknown): string;
    ownerQuery(
      query: AdaptiveViewQuery,
      cursor?: string,
    ): Record<string, unknown>;
  };
  draftSchema: ModelSchema<Omit<AdaptiveViewDraft, 'preview'>>;
  refreshContext(context: TenantContext): Promise<TenantContext>;
  released(
    context: TenantContext,
    feature: 'adaptive-saved-views' | 'adaptive-view-generation',
  ): Promise<boolean>;
  readers: Partial<Record<AdaptiveViewDomain, ViewReadAdapter>>;
  fields?(
    context: TenantContext,
    domain: AdaptiveViewDomain,
  ): Promise<readonly { id: string; archived: boolean }[]>;
  copyActions?(
    context: TenantContext,
    query: AdaptiveViewQuery,
  ): Promise<AdaptiveViewQuery>;
  validateActions?(
    context: TenantContext,
    query: AdaptiveViewQuery,
  ): Promise<void>;
  validateRoles?(
    context: TenantContext,
    roleIds: readonly string[],
  ): Promise<void>;
  identities?(context: TenantContext): Promise<{
    items: readonly {
      kind: 'location' | 'supplier' | 'connection' | 'customer';
      id: string;
      label: string;
    }[];
    complete: boolean;
  }>;
  model?: ModelGateway;
  trace(context: TenantContext): TraceContext;
  id(): string;
  now(): Date;
}

function canReadDomain(
  context: TenantContext,
  query: Pick<AdaptiveViewQuery, 'domain' | 'filters'>,
) {
  if (query.domain !== 'decisions')
    return context.permissions.has(viewPermissions[query.domain]);
  const domain = query.filters.domain;
  const permissions: Record<string, string> = {
    orders: 'orders.read',
    inventory: 'inventory.read',
    fulfillment: 'fulfillment.read',
    procurement: 'procurement.read',
    operations: 'issues.read',
  };

  return typeof domain === 'string' && permissions[domain]
    ? context.permissions.has(permissions[domain])
    : Object.values(permissions).some((permission) =>
        context.permissions.has(permission),
      );
}

/** Private views remain private even to workspace administrators. */
function canReadView(
  context: TenantContext,
  view: StoredAdaptiveView,
): boolean {
  return (
    context.tenantId === view.tenantId &&
    (context.actor.id === view.ownerId ||
      view.sharing.scope === 'workspace' ||
      (view.sharing.scope === 'roles' &&
        view.sharing.roleIds.includes(context.actor.role.id))) &&
    canReadDomain(context, view.query)
  );
}

/** Only owners and authorized managers may revise a visible view. */
function canEditView(
  context: TenantContext,
  view: StoredAdaptiveView,
): boolean {
  return (
    canReadView(context, view) &&
    (view.ownerId === context.actor.id ||
      hasPermission(context, 'adaptive.views.manage'))
  );
}

/** Stores reviewed query descriptions and reauthorizes every read, preview and change. */
export function createViewsService(deps: ViewsDependencies) {
  async function authorize(context: TenantContext, write = false) {
    requireTenant(context, context.tenantId);
    const fresh = await deps.refreshContext(context);
    requireTenant(fresh, context.tenantId);
    if (fresh.actor.id !== context.actor.id)
      throw new IdentityError(403, 'FORBIDDEN', 'Sign in again to continue.');
    if (write) requireChangesAllowed(fresh);
    if (!(await deps.released(fresh, 'adaptive-saved-views')))
      throw new IdentityError(404, 'NOT_FOUND', 'Saved views are unavailable.');

    return fresh;
  }

  function expose(
    context: TenantContext,
    value: StoredAdaptiveView,
  ): AdaptiveView {
    return { ...value, canEdit: canEditView(context, value) };
  }

  async function find(
    tx: ViewsTransaction,
    context: TenantContext,
    id: string,
    edit = false,
  ) {
    const value = await tx.get(id);
    if (!value || !canReadView(context, value))
      throw new IdentityError(404, 'NOT_FOUND', 'View not found.');
    if (edit && !canEditView(context, value))
      throw new IdentityError(
        403,
        'FORBIDDEN',
        'Only the owner or a view manager can change this view.',
      );

    return value;
  }

  async function validateQuery(context: TenantContext, raw: AdaptiveViewQuery) {
    const query = deps.validation.query(raw);
    if (!canReadDomain(context, query))
      throw new IdentityError(
        403,
        'FORBIDDEN',
        'Your role cannot read this record source.',
      );
    if (query.domain === 'orders' && query.filters.customerId)
      requirePermission(context, 'customers.read');
    const reader = deps.readers[query.domain];
    if (!reader)
      throw new IdentityError(
        503,
        'SERVICE_UNAVAILABLE',
        'This record source is unavailable.',
      );
    const customQuery =
      query.customFilters.length > 0 ||
      query.sort?.field.startsWith('custom:') ||
      query.groupBy?.startsWith('custom:');
    if (customQuery && !reader.supportsCustomQueries)
      throw new IdentityError(
        422,
        'VALIDATION_ERROR',
        'This record source cannot yet combine custom field filters or ordering with its live query.',
      );
    if (!query.sort?.field.startsWith('custom:'))
      deps.validation.ownerQuery(query);
    else deps.validation.ownerQuery({ ...query, sort: null });
    if (
      (query.groupBy || query.metrics.length || query.charts.length) &&
      !reader.supportsAggregates
    )
      throw new IdentityError(
        422,
        'VALIDATION_ERROR',
        'Grouping and metrics require a complete query adapter for this source.',
      );
    const available = new Set(reader.columns ?? viewColumns[query.domain]);
    const fields = (await deps.fields?.(context, query.domain)) ?? [];
    for (const item of fields)
      if (!item.archived) available.add(`custom:${item.id}`);
    const references = [
      query.groupBy,
      query.sort?.field,
      ...query.customFilters.map((filter) => `custom:${filter.fieldId}`),
      ...query.metrics.map((metric) => metric.field),
      ...query.charts.map((chart) => chart.groupBy),
    ].filter((value): value is string => !!value);
    for (const reference of references) {
      // Native sort keys belong to the owner's query schema rather than display columns.
      if (reference === query.sort?.field && !reference.startsWith('custom:'))
        continue;
      if (!available.has(reference))
        throw new IdentityError(
          422,
          'VALIDATION_ERROR',
          'A filter, grouping or metric references an unavailable field.',
        );
    }
    if (query.actions.length) {
      if (!deps.validateActions)
        throw new IdentityError(
          422,
          'VALIDATION_ERROR',
          'View actions are unavailable.',
        );
      await deps.validateActions(context, query);
    }

    return { query, reader, available };
  }

  async function previewFresh(
    context: TenantContext,
    raw: AdaptiveViewQuery,
    cursor?: string,
    selectedRecordIds?: readonly string[],
  ): Promise<AdaptiveViewPreview> {
    const { query, reader, available } = await validateQuery(context, raw);
    const filters = deps.validation.ownerQuery(
      query.sort?.field.startsWith('custom:')
        ? { ...query, sort: null }
        : query,
      cursor,
    );
    const result = await reader.read(
      context,
      filters,
      query,
      selectedRecordIds,
    );
    const warnings = [...(result.warnings ?? [])];
    const missing = query.columns.filter((column) => !available.has(column));
    if (missing.length)
      warnings.push(
        'Some columns are unavailable. Their values are omitted; the saved query has not changed.',
      );
    if (query.filters.stockBlocked === true)
      warnings.push(
        'Only explicit source stock holds observed within five minutes are included. Missing, stale or incomplete fulfillment evidence does not establish whether other orders are stock-blocked.',
      );
    if (result.nextCursor)
      warnings.push(
        'More matching records are available. This page is not the complete result.',
      );
    const items = result.items.map((item) =>
      Object.fromEntries(
        Object.entries(item).filter(
          ([key]) =>
            key === 'id' || (query.columns.includes(key) && available.has(key)),
        ),
      ),
    );

    return deps.validation.preview({
      ...result,
      items,
      totalCount: result.totalCount ?? null,
      warnings,
      availableColumns: [...available],
      aggregates: result.aggregates ?? [],
      groups: result.groups ?? [],
      chartSeries: result.chartSeries ?? [],
    });
  }

  async function validateInput(context: TenantContext, raw: AdaptiveViewInput) {
    const input = deps.validation.input(raw);
    await validateQuery(context, input.query);
    if (input.sharing.scope === 'roles') {
      if (!deps.validateRoles)
        throw new IdentityError(
          422,
          'VALIDATION_ERROR',
          'Role sharing is unavailable.',
        );
      await deps.validateRoles(context, input.sharing.roleIds);
    }

    return input;
  }

  return {
    async list(context: TenantContext) {
      const fresh = await authorize(context);

      return deps.store.transaction(fresh.tenantId, async (tx) => ({
        items: (await tx.list())
          .filter((view) => !view.archived && canReadView(fresh, view))
          .map((view) => expose(fresh, view)),
        builtIns: builtInViews.filter((view) =>
          canReadDomain(fresh, view.query),
        ),
      }));
    },
    async get(context: TenantContext, id: string) {
      const fresh = await authorize(context);

      return deps.store.transaction(fresh.tenantId, async (tx) =>
        expose(fresh, await find(tx, fresh, id)),
      );
    },
    async create(context: TenantContext, raw: AdaptiveViewInput) {
      const fresh = await authorize(context, true);
      const input = await validateInput(fresh, raw);
      const now = deps.now().toISOString();
      const value: StoredAdaptiveView = {
        name: input.name,
        description: input.description,
        sharing: input.sharing,
        query: input.query,
        id: input.commandId,
        tenantId: fresh.tenantId,
        ownerId: fresh.actor.id,
        revision: 1,
        archived: false,
        createdAt: now,
        updatedAt: now,
      };

      return deps.store.transaction(fresh.tenantId, async (tx) => {
        const existing = await tx.get(value.id);
        if (existing) {
          if (existing.ownerId !== fresh.actor.id)
            throw new IdentityError(
              409,
              'CONFLICT',
              'This command identity was already used.',
            );
          const first = (await tx.history(value.id)).items.find(
            (item) => item.revision === 1,
          );
          if (
            !first ||
            canonicalJson({
              name: first.name,
              description: first.description,
              sharing: first.sharing,
              query: first.query,
            }) !==
              canonicalJson({
                name: input.name,
                description: input.description,
                sharing: input.sharing,
                query: input.query,
              })
          )
            throw new IdentityError(
              409,
              'CONFLICT',
              'This command identity was already used for another view.',
            );

          return expose(fresh, existing);
        }
        await tx.save(value, fresh.actor.id, null);

        return expose(fresh, value);
      });
    },
    async update(
      context: TenantContext,
      id: string,
      raw: AdaptiveViewInput & { expectedRevision: number },
    ) {
      const fresh = await authorize(context, true);
      const { expectedRevision, ...inputRaw } = raw;
      const input = await validateInput(fresh, inputRaw);

      return deps.store.transaction(fresh.tenantId, async (tx) => {
        const current = await find(tx, fresh, id, true);
        if (current.archived)
          throw new IdentityError(
            409,
            'CONFLICT',
            'Archived views cannot be revised.',
          );
        const value: StoredAdaptiveView = {
          ...current,
          name: input.name,
          description: input.description,
          sharing: input.sharing,
          query: input.query,
          revision: current.revision + 1,
          updatedAt: deps.now().toISOString(),
        };
        await tx.save(value, fresh.actor.id, expectedRevision);

        return expose(fresh, value);
      });
    },
    async archive(
      context: TenantContext,
      id: string,
      expectedRevision: number,
    ) {
      const fresh = await authorize(context, true);

      return deps.store.transaction(fresh.tenantId, async (tx) => {
        const current = await find(tx, fresh, id, true);
        const value = {
          ...current,
          archived: true,
          revision: current.revision + 1,
          updatedAt: deps.now().toISOString(),
        };
        await tx.save(value, fresh.actor.id, expectedRevision);

        return expose(fresh, value);
      });
    },
    async restore(
      context: TenantContext,
      id: string,
      expectedRevision: number,
    ) {
      const fresh = await authorize(context, true);

      return deps.store.transaction(fresh.tenantId, async (tx) => {
        const current = await find(tx, fresh, id, true);
        const value = {
          ...current,
          archived: false,
          revision: current.revision + 1,
          updatedAt: deps.now().toISOString(),
        };
        await tx.save(value, fresh.actor.id, expectedRevision);

        return expose(fresh, value);
      });
    },
    async duplicate(
      context: TenantContext,
      id: string,
      name: string,
      commandId: string,
    ) {
      const original = await this.get(context, id);

      return this.create(context, {
        commandId,
        name,
        description: original.description,
        query: deps.copyActions
          ? await deps.copyActions(context, original.query)
          : original.query,
        sharing: { scope: 'private', roleIds: [] },
        reviewed: true,
      });
    },
    async history(context: TenantContext, id: string) {
      const fresh = await authorize(context);

      return deps.store.transaction(fresh.tenantId, async (tx) => {
        await find(tx, fresh, id);
        const history = await tx.history(id);

        return {
          ...history,
          items: history.items.filter((view) => canReadView(fresh, view)),
        };
      });
    },
    async preview(
      context: TenantContext,
      query: AdaptiveViewQuery,
      cursor?: string,
      selectedRecordIds?: readonly string[],
    ) {
      return previewFresh(
        await authorize(context),
        query,
        cursor,
        selectedRecordIds,
      );
    },
    async generate(
      context: TenantContext,
      prompt: string,
    ): Promise<AdaptiveViewDraft> {
      const fresh = await authorize(context, true);
      const text = deps.validation.prompt(prompt);
      if (
        !(await deps.released(fresh, 'adaptive-view-generation')) ||
        !deps.model
      )
        return {
          status: 'unavailable',
          query: null,
          explanation:
            'View generation is unavailable. You can build a view manually.',
          warnings: [],
          preview: null,
        };
      const identities = (await deps.identities?.(fresh)) ?? {
        items: [],
        complete: false,
      };
      try {
        const result = await deps.model.generate<
          Omit<AdaptiveViewDraft, 'preview'>
        >(deps.trace(fresh), {
          profile: authoringModelProfile,
          dataPolicy: {
            classification: 'sensitive',
            region: 'EU',
            zeroDataRetention: true,
          },
          maxOutputTokens: 3000,
          signal: AbortSignal.timeout(30000),
          output: deps.draftSchema,
          messages: [
            {
              role: 'system',
              content: `Propose a read-only live view. Never invent identities or UUIDs. Canonical identities: ${JSON.stringify(identities)}. Labels do not establish country or geography. Match a named identity only if exactly one supplied identity fits; otherwise ask for clarification. Return needs_clarification for named warehouses, suppliers, customers or connections without an exact supplied identity; unsupported for relationships or causal claims unsupported by filters. 'Orders delayed by stock at my German warehouse' requires exactly one supplied warehouse identity; use orders filters locationId:<exact canonical UUID>,stockBlocked:true when resolved. This only selects explicit fresh source inventory_out_of_stock holds; missing and stale reads are unknown and excluded. Explain that 'stuck' does not prove stock caused the delay. Do not generate actions. No SQL or write instructions. Only these authorized domains/columns: ${JSON.stringify(Object.fromEntries(Object.entries(viewColumns).filter(([domain]) => fresh.permissions.has(viewPermissions[domain as AdaptiveViewDomain]))))}. Supported owner filter schemas: ${JSON.stringify(
                Object.fromEntries(
                  Object.entries(viewPermissions)
                    .filter(([, permission]) =>
                      fresh.permissions.has(permission),
                    )
                    .map(([domain]) => [
                      domain,
                      domain === 'orders'
                        ? 'q,view(all|outstanding|overdue|needs_you|differs|stuck),status,paymentStatus,connectionId,customerId,locationId,stockBlocked(true:explicit fresh source inventory_out_of_stock hold),placedFrom,placedBefore,updatedFrom,updatedBefore'
                        : domain === 'inventory'
                          ? 'q,view(all|differs|unknown),skuId,locationId,connectionId'
                          : domain === 'decisions'
                            ? 'view(all|mine|unassigned),domain(orders|fulfillment|inventory|procurement|operations),reason'
                            : domain === 'fulfillment'
                              ? 'q,view,connectionId,locationId,kind'
                              : domain === 'products'
                                ? 'q,view,connectionId,missingFrom'
                                : domain === 'customers'
                                  ? 'q,state,connectionId,externalId'
                                  : domain === 'issues'
                                    ? 'view(needs_you|active|history),ownerId,class,severity,state'
                                    : 'no filters',
                    ]),
                ),
              )}. Use table layout, null sort/group, empty customFilters/metrics/charts/actions. Ready requires a fully supported query. Explain evidence limits and incomplete paginated results. This is a draft requiring explicit user review.`,
            },
            { role: 'user', content: text },
          ],
        });
        if (!result.output) throw new ModelGatewayError('invalid_output');
        const draft = result.output;
        if (draft.status === 'ready' && !draft.query)
          return {
            status: 'unavailable',
            query: null,
            explanation:
              'View generation did not provide a validated query. Build a view manually or clarify the description.',
            warnings: [],
            preview: null,
          };
        if (draft.status !== 'ready' || !draft.query)
          return { ...draft, query: null, preview: null };
        const identityFilters = [
          'locationId',
          'supplierId',
          'connectionId',
          'customerId',
        ];
        if (
          identityFilters.some(
            (key) =>
              draft.query?.filters[key] &&
              !identities.items.some(
                (item) => item.id === draft.query?.filters[key],
              ),
          )
        )
          return {
            status: 'needs_clarification',
            query: null,
            explanation:
              'Choose the exact workspace record or warehouse. The description does not establish a unique authorized identity.',
            warnings: [],
            preview: null,
          };
        if (
          /(?:delayed?\s+by\s+(?:stock|inventory)|stock\s+(?:delay|shortage)|bestand.*verzögert)/i.test(
            text,
          ) &&
          draft.query.domain === 'orders' &&
          draft.query.filters.stockBlocked !== true
        )
          return {
            status: 'unsupported',
            query: null,
            explanation:
              'An order being stuck does not establish that stock caused the delay. Choose an exact warehouse and inspect independent stock and fulfillment evidence before defining this causal view.',
            warnings: [],
            preview: null,
          };
        if (draft.query.actions.length)
          return {
            status: 'unsupported',
            query: null,
            explanation:
              'Generated views cannot propose actions. Add governed actions manually after review.',
            warnings: [],
            preview: null,
          };
        const preview = await previewFresh(fresh, draft.query);

        return { ...draft, preview };
      } catch (error) {
        if (error instanceof IdentityError) {
          if (error.statusCode === 403 || error.statusCode === 404) throw error;

          return {
            status: 'unsupported',
            query: null,
            explanation:
              'This request needs filters, identities or relationships the live query does not support. Build a supported view manually or clarify the request.',
            warnings: [],
            preview: null,
          };
        }

        return {
          status: 'unavailable',
          query: null,
          explanation:
            'View generation could not produce a validated query. You can build a view manually.',
          warnings: [],
          preview: null,
        };
      }
    },
  };
}

export type AdaptiveViews = ReturnType<typeof createViewsService>;
