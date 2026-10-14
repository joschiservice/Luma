import type { Permission, TenantContext } from '@luma/identity';
import {
  hasPermission,
  IdentityError,
  requireChangesAllowed,
  requirePermission,
  requireTenant,
} from '@luma/identity';

import type {
  ActionReview,
  ActionScalar,
  ViewAction,
  ViewActionResult,
} from '../domain/actions.js';
import type { AdaptiveViewQuery } from '../domain/views.js';

/** An owner adapter exposes its existing governed proposal command and revalidation. */
export interface ViewActionCapability {
  id: string;
  kind: 'capability' | 'workflow';
  version?: string;
  domains: readonly string[];
  permissions: readonly Permission[];
  inputs: Readonly<Record<string, 'string' | 'number' | 'boolean'>>;
  available(context: TenantContext): Promise<string | null>;
  /** Validates literal inputs at save time and complete mapped inputs before a proposal. */
  validateInputs?(inputs: Record<string, ActionScalar>): void;
  review(
    context: TenantContext,
    recordId: string,
    inputs: Record<string, ActionScalar>,
  ): Promise<ActionReview>;
  /** Must deduplicate commandId in its owner. Uncertain effects must never be retried blindly. */
  propose(
    context: TenantContext,
    recordId: string,
    commandId: string,
    inputs: Record<string, ActionScalar>,
    review: ActionReview,
  ): Promise<Omit<ViewActionResult, 'recordId'>>;
}

interface ActionView {
  query: AdaptiveViewQuery;
}

/** Revalidates immutable review evidence and dispatches independent owner commands per row. */
export function createViewActions(deps: {
  refreshContext(context: TenantContext): Promise<TenantContext>;
  released(context: TenantContext): Promise<boolean>;
  view(context: TenantContext, viewId: string): Promise<ActionView>;
  /** Loads current selected records through the saved query; IDs outside its scope are refused. */
  rows(
    context: TenantContext,
    view: ActionView,
    ids: string[],
  ): Promise<Record<string, unknown>[]>;
  catalog(context: TenantContext): Promise<ViewActionCapability[]>;
  /** Scalar types of the row fields a list's view rows carry, keyed by catalog column ID. */
  rowTypes?(
    context: TenantContext,
    domain: string,
  ): Promise<Readonly<Record<string, 'string' | 'number' | 'boolean'>>>;
  digest(value: unknown): string;
  commandId(commandId: string, recordId: string): string;
  receipts?: {
    get(
      context: TenantContext,
      commandId: string,
      digest: string,
    ): Promise<ViewActionResult[] | null>;
    claim(
      context: TenantContext,
      commandId: string,
      digest: string,
      initial: ViewActionResult[],
    ): Promise<ViewActionResult[] | null>;
    save(
      context: TenantContext,
      commandId: string,
      digest: string,
      results: ViewActionResult[],
    ): Promise<void>;
  };
}) {
  async function authorize(context: TenantContext, write = false) {
    requireTenant(context, context.tenantId);
    const fresh = await deps.refreshContext(context);
    requireTenant(fresh, context.tenantId);
    if (fresh.actor.id !== context.actor.id)
      throw new IdentityError(403, 'FORBIDDEN', 'Sign in again to continue.');
    if (write) requireChangesAllowed(fresh);
    if (!(await deps.released(fresh)))
      throw new IdentityError(
        503,
        'SERVICE_UNAVAILABLE',
        'View actions are not enabled for this workspace.',
      );

    return fresh;
  }

  function match(action: ViewAction, catalog: ViewActionCapability[]) {
    return catalog.find(
      (c) =>
        c.id === action.target.id &&
        c.kind === action.target.kind &&
        (c.version ?? null) === (action.target.version ?? null),
    );
  }

  function mappings(
    action: ViewAction,
    capability: ViewActionCapability,
    row?: Record<string, unknown>,
  ) {
    const result: Record<string, ActionScalar> = {};
    if (
      Object.keys(action.inputs).some((key) => !(key in capability.inputs)) ||
      Object.keys(capability.inputs).some((key) => !(key in action.inputs))
    )
      throw new IdentityError(
        422,
        'VALIDATION_ERROR',
        'Map exactly the supported action inputs.',
      );
    for (const [key, type] of Object.entries(capability.inputs)) {
      const mapping = action.inputs[key]!;
      if (!row && mapping.source === 'row') continue;
      const value =
        mapping.source === 'row' ? row?.[mapping.field] : mapping.value;
      if (
        typeof value !== type ||
        (typeof value === 'number' && !Number.isFinite(value))
      )
        throw new IdentityError(
          422,
          'VALIDATION_ERROR',
          `The action input ${key} needs a ${type} value.`,
        );
      if (
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
      )
        result[key] = value;
    }

    return result;
  }

  async function prepare(
    context: TenantContext,
    viewId: string,
    actionId: string,
    request: { commandId: string; recordIds: string[] },
  ) {
    const view = await deps.view(context, viewId);
    const action = view.query.actions.find((a) => a.id === actionId);
    if (!action)
      throw new IdentityError(404, 'NOT_FOUND', 'View action not found.');
    const capability = match(action, await deps.catalog(context));
    if (!capability)
      throw new IdentityError(
        409,
        'NOT_READY',
        'This action is unavailable. Its capability or published version was removed.',
      );
    for (const permission of capability.permissions)
      requirePermission(context, permission);
    if (!capability.domains.includes(view.query.domain))
      throw new IdentityError(
        422,
        'VALIDATION_ERROR',
        'This action does not support this record type.',
      );
    const missing = await capability.available(context);
    const rows = await deps.rows(context, view, request.recordIds);
    const reviews = [];
    for (const recordId of request.recordIds) {
      const row = rows.find((r) => r.id === recordId);
      if (!row)
        throw new IdentityError(
          404,
          'NOT_FOUND',
          'A selected record is unavailable in this view.',
        );
      const inputs = mappings(action, capability, row);
      capability.validateInputs?.(inputs);
      if (missing)
        reviews.push({ recordId, inputs, review: null, reason: missing });
      else {
        try {
          reviews.push({
            recordId,
            inputs,
            review: await capability.review(context, recordId, inputs),
            reason: null,
          });
        } catch (error) {
          if (!(error instanceof IdentityError)) throw error;
          reviews.push({
            recordId,
            inputs,
            review: null,
            reason: error.message,
          });
        }
      }
    }
    const reviewDigest = deps.digest({
      tenant: context.tenantId,
      actor: context.actor.id,
      viewId,
      action,
      commandId: request.commandId,
      reviews,
    });

    return { capability, reviews, reviewDigest };
  }

  return {
    /** Lists only supported bindings the current actor can invoke on this record type. */
    async definitions(context: TenantContext, domain: string) {
      context = await authorize(context);
      const catalog = await deps.catalog(context);
      const items = [];
      for (const capability of catalog) {
        if (
          !capability.domains.includes(domain) ||
          !capability.permissions.every((permission) =>
            hasPermission(context, permission),
          )
        )
          continue;
        const reason = await capability.available(context);
        items.push({
          target: {
            kind: capability.kind,
            id: capability.id,
            ...(capability.version ? { version: capability.version } : {}),
          },
          inputs: Object.entries(capability.inputs).map(([key, type]) => ({
            key,
            type,
          })),
          requiredPermissions: [...capability.permissions],
          available: reason === null,
          reason,
        });
      }

      return { items };
    },
    /** Copies only bindings the actor may invoke; copying a view never grants an action. */
    async copyBindings(
      context: TenantContext,
      query: AdaptiveViewQuery,
    ): Promise<AdaptiveViewQuery> {
      const catalog = await deps.catalog(context);

      return {
        ...query,
        actions: query.actions.filter((action) => {
          const capability = match(action, catalog);

          return (
            !!capability &&
            capability.permissions.every((permission) =>
              hasPermission(context, permission),
            )
          );
        }),
      };
    },
    /** Refuses invented capabilities and invalid literal input mappings when a view is saved. */
    async validate(context: TenantContext, query: ActionView['query']) {
      const catalog = await deps.catalog(context);
      const types = await deps.rowTypes?.(context, query.domain);
      for (const action of query.actions) {
        const capability = match(action, catalog);
        if (!capability || !capability.domains.includes(query.domain))
          throw new IdentityError(
            422,
            'VALIDATION_ERROR',
            'Choose an action from the supported record catalog.',
          );
        for (const permission of capability.permissions)
          requirePermission(context, permission);
        // Row fields are catalog column IDs the view lists explicitly, or the record ID.
        const visible = new Set(query.state.columns.map((column) => column.id));
        for (const mapping of Object.values(action.inputs))
          if (
            mapping.source === 'row' &&
            !visible.has(mapping.field) &&
            mapping.field !== 'id'
          )
            throw new IdentityError(
              422,
              'VALIDATION_ERROR',
              'Choose a supported visible row field for each action input.',
            );
        if (types)
          for (const [key, mapping] of Object.entries(action.inputs))
            if (
              mapping.source === 'row' &&
              types[mapping.field] !== capability.inputs[key]
            )
              throw new IdentityError(
                422,
                'VALIDATION_ERROR',
                `The row field ${mapping.field} cannot supply the action input ${key}.`,
              );
        capability.validateInputs?.(mappings(action, capability));
      }
    },
    /** Omits action buttons when the actor lacks their required permissions. */
    async catalog(context: TenantContext, viewId: string) {
      context = await authorize(context);
      const [view, catalog] = await Promise.all([
        deps.view(context, viewId),
        deps.catalog(context),
      ]);
      const items = [];
      for (const action of view.query.actions) {
        const capability = match(action, catalog);
        if (
          capability &&
          !capability.permissions.every((p) => hasPermission(context, p))
        )
          continue;
        const reason = capability
          ? await capability.available(context)
          : 'The capability or published workflow is unavailable.';
        items.push({
          id: action.id,
          label: action.label,
          available: capability !== undefined && reason === null,
          reason,
          requiredPermissions: capability ? [...capability.permissions] : [],
        });
      }

      return { items };
    },
    /** Returns a before/after proposal for every selected record, bound to fresh evidence. */
    async preview(
      context: TenantContext,
      viewId: string,
      actionId: string,
      request: { commandId: string; recordIds: string[] },
    ) {
      context = await authorize(context);
      const prepared = await prepare(context, viewId, actionId, request);

      return {
        reviewDigest: prepared.reviewDigest,
        items: prepared.reviews.map((r) => ({
          recordId: r.recordId,
          available: r.review !== null,
          reason: r.reason,
          changes: r.review?.changes ?? [],
          scope: r.review?.scope ?? '',
          approval: r.review?.approval ?? '',
          verification: r.review?.verification ?? '',
        })),
      };
    },
    /** Proposes independent, idempotent owner commands; no UI action grants approval. */
    async run(
      context: TenantContext,
      viewId: string,
      actionId: string,
      request: { commandId: string; recordIds: string[]; reviewDigest: string },
    ) {
      context = await authorize(context, true);
      await deps.view(context, viewId);
      const requestDigest = deps.digest({
        tenantId: context.tenantId,
        actorId: context.actor.id,
        viewId,
        actionId,
        request,
      });
      const recorded = await deps.receipts?.get(
        context,
        request.commandId,
        requestDigest,
      );
      if (recorded) return { items: recorded };
      const prepared = await prepare(context, viewId, actionId, request);
      if (prepared.reviewDigest !== request.reviewDigest)
        throw new IdentityError(
          409,
          'CONFLICT',
          'The proposed change or its evidence changed. Review it again.',
        );
      const pending: ViewActionResult[] = prepared.reviews.map((record) => ({
        recordId: record.recordId,
        state: 'uncertain',
        reason:
          'This command may have started. Open the record to reconcile its owner result before retrying.',
        proposalId: null,
        destination: null,
      }));
      const existing = await deps.receipts?.claim(
        context,
        request.commandId,
        requestDigest,
        pending,
      );
      if (existing) return { items: existing };
      const items: ViewActionResult[] = [];
      for (const record of prepared.reviews) {
        if (!record.review) {
          items.push({
            recordId: record.recordId,
            state: 'unavailable',
            reason: record.reason,
            proposalId: null,
            destination: null,
          });
          continue;
        }
        try {
          const fresh = await authorize(context, true);
          for (const permission of prepared.capability.permissions)
            requirePermission(fresh, permission);
          items.push({
            recordId: record.recordId,
            ...(await prepared.capability.propose(
              fresh,
              record.recordId,
              deps.commandId(request.commandId, record.recordId),
              record.inputs,
              record.review,
            )),
          });
        } catch (error) {
          items.push({
            recordId: record.recordId,
            state: error instanceof IdentityError ? 'failed' : 'uncertain',
            reason:
              error instanceof IdentityError
                ? error.message
                : 'The command outcome is uncertain. Open the record to reconcile it before retrying.',
            proposalId: null,
            destination: null,
          });
        }
        await deps.receipts?.save(context, request.commandId, requestDigest, [
          ...items,
          ...pending.slice(items.length),
        ]);
      }
      await deps.receipts?.save(
        context,
        request.commandId,
        requestDigest,
        items,
      );

      return { items };
    },
  };
}

export type ViewActions = ReturnType<typeof createViewActions>;
