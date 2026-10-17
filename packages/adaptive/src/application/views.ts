import type { TenantContext } from '@luma/identity';
import {
  hasPermission,
  requireChangesAllowed,
  requireTenant,
} from '@luma/identity';
import type { ModelGateway, ModelSchema, TraceContext } from '@luma/platform';
import {
  authoringModelProfile,
  canonicalJson,
  conflict,
  invalid,
  ModelGatewayError,
  notFound,
  ServiceError,
  unavailable,
} from '@luma/platform';

import type { CustomField } from '../domain/fields.js';
import type {
  AdaptiveView,
  AdaptiveViewDomain,
  AdaptiveViewDraft,
  AdaptiveViewInput,
  AdaptiveViewPreview,
  AdaptiveViewQuery,
  AdaptiveViewQueryV1,
  StoredAdaptiveView,
  ViewExecutionQuery,
  ViewHistory,
  ViewReaderDomain,
} from '../domain/views.js';
import {
  builtInViews,
  viewPermissions,
  viewReaderColumns,
  viewReaderDomains,
  viewReaderKeys,
} from '../domain/views.js';

export interface ViewsTransaction {
  /** Live views the actor owns or that are shared, newest first. */
  list(actorId: string): Promise<StoredAdaptiveView[]>;
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
    query: ViewExecutionQuery,
    selectedRecordIds?: readonly string[],
  ): Promise<ViewReadResult>;
  /** Explicitly enabled only by an adapter that combines custom predicates before pagination. */
  supportsCustomQueries?: boolean;
  /** Explicitly enabled only when grouping/aggregation covers the whole filtered query. */
  supportsAggregates?: boolean;
  columns?: readonly string[];
}

/** The reader's current permissions. */
export interface ViewPermissions {
  has(permission: string): boolean;
}

/** A live custom field the reader may use in a view. */
export interface ViewCustomField {
  id: string;
  type: CustomField['type'];
}

/** A reason a saved view cannot run; `forbidden` when the reader's role is the reason. */
export interface ViewQueryIssue {
  message: string;
  forbidden: boolean;
}

/** A saved view compiled for the view engine, with each column's reader item key. */
export interface ViewExecution {
  query: ViewExecutionQuery;
  /** Catalog column IDs in display order; `key` is null when no reader supplies the column. */
  columns: { id: string; key: string | null }[];
}

export interface ViewsDependencies {
  store: ViewsStore;
  validation: {
    /** Parses a query in format 1 or 2 and returns format 2. */
    query(value: unknown): AdaptiveViewQuery;
    input(
      value: unknown,
    ): Omit<AdaptiveViewInput, 'query'> & { query: AdaptiveViewQuery };
    preview(value: unknown): AdaptiveViewPreview;
    prompt(value: unknown): string;
    ownerQuery(
      query: ViewExecutionQuery,
      cursor?: string,
    ): Record<string, unknown>;
    /** Checks a view against its list catalog and the reader's permissions. */
    issues(
      query: AdaptiveViewQuery,
      options: {
        permissions: ViewPermissions;
        customFields: readonly ViewCustomField[];
      },
    ): ViewQueryIssue[];
    /** Compiles a view for the engine; refuses what the engine cannot yet run with 422. */
    execution(
      query: AdaptiveViewQuery,
      customFields: readonly ViewCustomField[],
    ): ViewExecution;
    /** Describes the lists a model may draft views for. */
    describe(
      domains: readonly ViewReaderDomain[],
      permissions: ViewPermissions,
    ): Record<string, unknown>;
  };
  draftSchema: ModelSchema<Omit<AdaptiveViewDraft, 'preview'>>;
  refreshContext(context: TenantContext): Promise<TenantContext>;
  released(
    context: TenantContext,
    feature: 'adaptive-saved-views' | 'adaptive-view-generation',
  ): Promise<boolean>;
  readers: Partial<Record<ViewReaderDomain, ViewReadAdapter>>;
  /** Custom fields of the list's record type the reader may see, including archived ones. */
  fields?(
    context: TenantContext,
    domain: AdaptiveViewDomain,
  ): Promise<
    readonly { id: string; archived: boolean; type: CustomField['type'] }[]
  >;
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

/**
 * Decisions span record domains: a view limited by `domain` conditions needs each named domain's
 * permission; an unlimited view needs any of them.
 */
function canReadDomain(
  context: TenantContext,
  query: Pick<AdaptiveViewQuery, 'domain' | 'state'>,
) {
  if (query.domain !== 'decisions')
    return context.permissions.has(viewPermissions[query.domain]);
  const permissions: Record<string, string> = {
    orders: 'orders.read',
    inventory: 'inventory.read',
    fulfillment: 'fulfillment.read',
    procurement: 'procurement.read',
    operations: 'issues.read',
  };
  const values = query.state.where.conditions
    .filter(
      (condition) =>
        condition.field === 'domain' &&
        (condition.op === 'any_of' || condition.op === 'is'),
    )
    .flatMap((condition) =>
      Array.isArray(condition.value) ? condition.value : [condition.value],
    );
  const named = values.flatMap((value) =>
    typeof value === 'string' && permissions[value] ? [permissions[value]] : [],
  );

  return named.length > 0 && named.length === values.length
    ? named.every((permission) => context.permissions.has(permission))
    : Object.values(permissions).some((permission) =>
        context.permissions.has(permission),
      );
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a view selects only explicit, fresh source stock holds. */
function selectsStockHolds(query: AdaptiveViewQuery) {
  return query.state.where.conditions.some(
    (condition) =>
      condition.field === 'stockBlocked' &&
      condition.op === 'is' &&
      condition.value === true,
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

const sharingRank = { private: 0, roles: 1, workspace: 2 } as const;

/**
 * Members without `adaptive.views.manage` keep views private. They may keep or narrow the
 * sharing of a view they already own, but never widen it to more people.
 */
function requireSharingAllowed(
  context: TenantContext,
  next: AdaptiveViewInput['sharing'],
  current?: AdaptiveViewInput['sharing'],
) {
  if (
    next.scope === 'private' ||
    hasPermission(context, 'adaptive.views.manage')
  )
    return;
  const narrower =
    current &&
    (sharingRank[next.scope] < sharingRank[current.scope] ||
      (next.scope === current.scope &&
        (next.scope === 'workspace' ||
          next.roleIds.every((role) => current.roleIds.includes(role)))));
  if (!narrower)
    throw new ServiceError(
      403,
      'FORBIDDEN',
      'Sharing a view with the workspace or with roles requires permission to manage views.',
    );
}

/** Stores reviewed query descriptions and reauthorizes every read, preview and change. */
export function createViewsService(deps: ViewsDependencies) {
  async function authorize(context: TenantContext, write = false) {
    requireTenant(context, context.tenantId);
    const fresh = await deps.refreshContext(context);
    requireTenant(fresh, context.tenantId);
    if (fresh.actor.id !== context.actor.id)
      throw new ServiceError(403, 'FORBIDDEN', 'Sign in again to continue.');
    if (write) requireChangesAllowed(fresh);
    if (!(await deps.released(fresh, 'adaptive-saved-views')))
      throw notFound('Saved views are unavailable.');

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
      throw notFound('View not found.');
    if (edit && !canEditView(context, value))
      throw new ServiceError(
        403,
        'FORBIDDEN',
        'Only the owner or a view manager can change this view.',
      );

    return value;
  }

  async function customFields(
    context: TenantContext,
    domain: AdaptiveViewDomain,
  ): Promise<ViewCustomField[]> {
    return ((await deps.fields?.(context, domain)) ?? [])
      .filter((field) => !field.archived)
      .map((field) => ({ id: field.id, type: field.type }));
  }

  /** Compiles a view for its reader and checks the reader can run every part of it. */
  function engine(
    query: AdaptiveViewQuery,
    fields: readonly ViewCustomField[],
  ) {
    const execution = deps.validation.execution(query, fields);
    const compiled = execution.query;
    const reader = deps.readers[compiled.domain];
    if (!reader) throw unavailable('This record source is unavailable.');
    const customSort = !!compiled.sort?.field.startsWith('custom:');
    if (
      (compiled.customFilters.length > 0 ||
        customSort ||
        compiled.groupBy?.startsWith('custom:')) &&
      !reader.supportsCustomQueries
    )
      throw invalid(
        'This record source cannot yet combine custom field filters or ordering with its live query.',
      );
    if (
      (compiled.groupBy || compiled.metrics.length || compiled.charts.length) &&
      !reader.supportsAggregates
    )
      throw invalid(
        'Grouping and metrics require a complete query adapter for this source.',
      );
    deps.validation.ownerQuery(
      customSort ? { ...compiled, sort: null } : compiled,
    );

    return { execution, reader, customSort };
  }

  /**
   * Validates a view in either format against its list catalog and returns it in format 2.
   * Metrics, charts and actions run only in the view engine, so their views must compile.
   */
  async function validateQuery(
    context: TenantContext,
    raw: AdaptiveViewQuery | AdaptiveViewQueryV1,
  ) {
    const query = deps.validation.query(raw);
    if (!canReadDomain(context, query))
      throw new ServiceError(
        403,
        'FORBIDDEN',
        'Your role cannot read this record source.',
      );
    const fields = await customFields(context, query.domain);
    const issues = deps.validation.issues(query, {
      permissions: context.permissions,
      customFields: fields,
    });
    const forbidden = issues.find((issue) => issue.forbidden);
    if (forbidden) throw new ServiceError(403, 'FORBIDDEN', forbidden.message);
    if (issues.length)
      throw invalid(
        `This view needs repair. ${issues
          .slice(0, 5)
          .map((issue) => issue.message)
          .join(' ')}`,
      );
    if (query.metrics.length || query.charts.length || query.actions.length)
      engine(query, fields);
    if (query.actions.length) {
      if (!deps.validateActions) throw invalid('View actions are unavailable.');
      await deps.validateActions(context, query);
    }

    return { query, fields };
  }

  async function previewFresh(
    context: TenantContext,
    raw: AdaptiveViewQuery | AdaptiveViewQueryV1,
    cursor?: string,
    selectedRecordIds?: readonly string[],
  ): Promise<AdaptiveViewPreview> {
    const { query, fields } = await validateQuery(context, raw);
    const { execution, reader, customSort } = engine(query, fields);
    const compiled = execution.query;
    const filters = deps.validation.ownerQuery(
      customSort ? { ...compiled, sort: null } : compiled,
      cursor,
    );
    const result = await reader.read(
      context,
      filters,
      compiled,
      selectedRecordIds,
    );
    const readable = new Set([
      ...(reader.columns ?? viewReaderKeys(compiled.domain)),
      ...fields.map((field) => `custom:${field.id}`),
    ]);
    const shown = execution.columns.flatMap(({ id, key }) =>
      key !== null && readable.has(key) ? [{ id, key }] : [],
    );
    const warnings = [...(result.warnings ?? [])];
    if (shown.length < execution.columns.length)
      warnings.push(
        'Some columns are unavailable. Their values are omitted; the saved query has not changed.',
      );
    if (selectsStockHolds(query))
      warnings.push(
        'Only explicit source stock holds observed within five minutes are included. Missing, stale or incomplete fulfillment evidence does not establish whether other orders are stock-blocked.',
      );
    if (result.nextCursor)
      warnings.push(
        'More matching records are available. This page is not the complete result.',
      );
    // Rows leave the engine keyed by catalog column IDs, so clients see one vocabulary.
    const items = result.items.map((item) =>
      Object.fromEntries([
        ['id', item.id],
        ...shown.map(({ id, key }) => [id, item[key]]),
      ]),
    );

    return deps.validation.preview({
      ...result,
      items,
      totalCount: result.totalCount ?? null,
      warnings,
      availableColumns: [
        ...Object.entries(viewReaderColumns[compiled.domain]).flatMap(
          ([id, key]) => (readable.has(key) ? [id] : []),
        ),
        ...fields.map((field) => `custom:${field.id}`),
      ],
      aggregates: result.aggregates ?? [],
      groups: result.groups ?? [],
      chartSeries: result.chartSeries ?? [],
    });
  }

  async function validateInput(context: TenantContext, raw: AdaptiveViewInput) {
    const input = deps.validation.input(raw);
    await validateQuery(context, input.query);
    if (input.sharing.scope === 'roles') {
      if (!deps.validateRoles) throw invalid('Role sharing is unavailable.');
      await deps.validateRoles(context, input.sharing.roleIds);
    }

    return input;
  }

  return {
    async list(context: TenantContext) {
      const fresh = await authorize(context);

      return deps.store.transaction(fresh.tenantId, async (tx) => ({
        items: (await tx.list(fresh.actor.id))
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
      requireSharingAllowed(fresh, input.sharing);
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
            throw conflict('This command identity was already used.');
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
            throw conflict(
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
          throw conflict('Archived views cannot be revised.');
        requireSharingAllowed(fresh, input.sharing, current.sharing);
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
      query: AdaptiveViewQuery | AdaptiveViewQueryV1,
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
      const authorized = viewReaderDomains.filter((domain) =>
        fresh.permissions.has(viewPermissions[domain]),
      );
      try {
        const result = await deps.model.generate<
          Omit<AdaptiveViewDraft, 'preview'>
        >(deps.trace(fresh), {
          profile: authoringModelProfile,
          dataPolicy: {
            classification: 'sensitive',
            region: fresh.dataRegion,
            zeroDataRetention: true,
          },
          maxOutputTokens: 3000,
          signal: AbortSignal.timeout(30000),
          output: deps.draftSchema,
          messages: [
            {
              role: 'system',
              content: `Propose a read-only live view as a format 2 saved view: {"version":2,"domain":<list>,"state":{"segment":<built-in view or null>,"where":{"match":"all","conditions":[{"field","op","value"}]},"sort":null or {"field","direction"},"group":null,"layout":"table","density":"comfortable","columns":[{"id"}],"properties":[],"preview":false},"metrics":[],"charts":[],"actions":[]}. Use only these authorized lists with their segments, column IDs, condition fields, operators and sort fields: ${JSON.stringify(deps.validation.describe(authorized, fresh.permissions))}. Condition values: a list for any_of, none_of and all_of; true or false for is on yes/no fields; ISO 8601 dates for before and after; omit value for empty and not_empty. Fields with "identities" take canonical identity UUIDs. Never invent identities or UUIDs. Canonical identities: ${JSON.stringify(identities)}. Labels do not establish country or geography. Match a named identity only if exactly one supplied identity fits; otherwise ask for clarification. Return needs_clarification for named warehouses, suppliers, customers or connections without an exact supplied identity; unsupported for relationships or causal claims the conditions cannot express. 'Orders delayed by stock at my German warehouse' requires exactly one supplied warehouse identity; when resolved use the orders conditions warehouse any_of [<exact canonical UUID>] and stockBlocked is true. stockBlocked selects only explicit fresh source inventory_out_of_stock holds; missing and stale reads are unknown and excluded. Explain that 'stuck' does not prove stock caused the delay. Do not generate actions, metrics or charts. No SQL or write instructions. Ready requires a fully supported query. Explain evidence limits and incomplete paginated results. This is a draft requiring explicit user review.`,
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
        const named = draft.query.state.where.conditions.flatMap((condition) =>
          (Array.isArray(condition.value)
            ? condition.value
            : [condition.value]
          ).filter(
            (value): value is string =>
              typeof value === 'string' && uuidPattern.test(value),
          ),
        );
        if (
          named.some((id) => !identities.items.some((item) => item.id === id))
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
          !selectsStockHolds(draft.query)
        )
          return {
            status: 'unsupported',
            query: null,
            explanation:
              'An order being stuck does not establish that stock caused the delay. Choose an exact warehouse and inspect independent stock and fulfillment evidence before defining this causal view.',
            warnings: [],
            preview: null,
          };
        if (
          draft.query.actions.length ||
          draft.query.metrics.length ||
          draft.query.charts.length
        )
          return {
            status: 'unsupported',
            query: null,
            explanation:
              'Generated views cannot propose actions, metrics or charts. Add them manually after review.',
            warnings: [],
            preview: null,
          };
        const preview = await previewFresh(fresh, draft.query);

        return { ...draft, preview };
      } catch (error) {
        if (error instanceof ServiceError) {
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
