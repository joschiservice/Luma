import type { AuditEntry } from '@luma/audit';
import type { TenantContext } from '@luma/identity';
import {
  hasPermission,
  IdentityError,
  requirePermission,
  requireTenant,
} from '@luma/identity';
import { conflict } from '@luma/platform';

import type {
  SupplierProductTerms,
  SupplierTermsInput,
  SupplierTermsVersion,
} from '../domain/supplier-terms.js';

/** @public Declaration emit names the transaction contract accepted by supplier terms composition. */
export interface SupplierTermsTransaction {
  /** Returns terms and their append-only history in this tenant. */
  list(filter: {
    supplierId?: string | undefined;
    skuId?: string | undefined;
  }): Promise<SupplierProductTerms[]>;
  /** Requires both identities to belong to this tenant. */
  exists(supplierId: string, skuId: string): Promise<boolean>;
  /** Refreshes observed freshness without rewriting an immutable term value. */
  recordRead?(
    supplierId: string,
    skuId: string,
    observedAt: string,
    complete: boolean,
  ): Promise<void>;
  /** Appends one version; no previous values are updated. */
  insert(version: SupplierTermsVersion): Promise<void>;
  /** Reads an exact retry's recorded result. */
  command(
    id: string,
  ): Promise<{ digest: string; result: SupplierProductTerms } | null>;
  /** Saves the command atomically with the terms and audit. */
  saveCommand(
    id: string,
    digest: string,
    result: SupplierProductTerms,
  ): Promise<void>;
  /** Records audit in this transaction. */
  audit(entry: AuditEntry): Promise<void>;
}

export interface SupplierTermsStore {
  /** Serializes terms and procurement writes within a tenant. */
  transaction<T>(
    tenantId: string,
    write: boolean,
    operation: (tx: SupplierTermsTransaction) => Promise<T>,
  ): Promise<T>;
}

/** Owns purchasing terms, human overrides, refreshed authorization and durable retries. */
export function createSupplierTermsService(deps: {
  store: SupplierTermsStore;
  refreshContext(context: TenantContext): Promise<TenantContext>;
  released(context: TenantContext): Promise<boolean>;
  parse(input: unknown): SupplierTermsInput;
  digest(input: unknown): string;
  id(): string;
  now(): Date;
}) {
  async function authorize(context: TenantContext, write: boolean) {
    requireTenant(context, context.tenantId);
    const fresh = await deps.refreshContext(context);
    requireTenant(fresh, context.tenantId);
    if (fresh.actor.id !== context.actor.id)
      throw new IdentityError(403, 'FORBIDDEN', 'Sign in again to continue.');
    requirePermission(fresh, write ? 'procurement.manage' : 'procurement.read');

    return fresh;
  }

  async function record(
    context: TenantContext,
    request: SupplierTermsInput,
    provenance?: Omit<
      SupplierTermsVersion,
      | 'id'
      | 'supplierId'
      | 'skuId'
      | 'revision'
      | 'values'
      | 'recordedAt'
      | 'actorId'
      | 'reason'
    >,
  ) {
    context = await authorize(context, true);
    if (!(await deps.released(context)))
      throw new IdentityError(
        403,
        'FORBIDDEN',
        'Purchasing terms are not enabled for this workspace.',
      );
    const digest = deps.digest({
      actorId: context.actor.id,
      request,
      provenance,
    });

    return deps.store.transaction(context.tenantId, true, async (tx) => {
      const prior = await tx.command(request.id);
      if (prior) {
        if (prior.digest !== digest)
          throw conflict(
            'This request ID was already used for different purchasing terms.',
          );

        return prior.result;
      }
      if (!(await tx.exists(request.supplierId, request.skuId)))
        throw new IdentityError(
          404,
          'NOT_FOUND',
          'Supplier or product not found.',
        );
      const current = (
        await tx.list({ supplierId: request.supplierId, skuId: request.skuId })
      )[0];
      if (!provenance && (current?.revision ?? 0) !== request.expectedRevision)
        throw conflict(
          'Purchasing terms changed. Refresh and review before saving.',
        );
      if (provenance)
        await tx.recordRead?.(
          request.supplierId,
          request.skuId,
          provenance.observedAt,
          provenance.complete,
        );
      if (provenance && current?.observed) {
        const old = current.observed;
        const oldTime = old.sourceUpdatedAt ?? old.observedAt;
        const newTime = provenance.sourceUpdatedAt ?? provenance.observedAt;
        if (newTime < oldTime) return current;
        if (
          deps.digest(old.values) === deps.digest(request.values) &&
          old.complete === provenance.complete &&
          old.connectionId === provenance.connectionId
        )
          return current;
      }
      if (
        request.values.preferred === true &&
        !provenance &&
        (await tx.list({ skuId: request.skuId })).some(
          (item) =>
            item.supplierId !== request.supplierId &&
            item.effective.preferred === true,
        )
      )
        throw conflict(
          'Another supplier is preferred. Remove that preference before changing suppliers.',
        );
      const recordedAt = deps.now().toISOString();
      const version: SupplierTermsVersion = {
        id: request.id,
        supplierId: request.supplierId,
        skuId: request.skuId,
        revision: (current?.revision ?? 0) + 1,
        values: request.values,
        recordedAt,
        actorId: context.actor.id,
        reason: request.reason,
        source: 'manual',
        observedAt: recordedAt,
        connectionId: null,
        sourceRecordId: null,
        sourceUpdatedAt: null,
        complete: true,
        ...provenance,
      };
      await tx.insert(version);
      await tx.audit({
        id: deps.id(),
        tenantId: context.tenantId,
        eventKey: `procurement-terms:${request.id}`,
        eventType: 'supplier_terms.recorded',
        schemaVersion: 1,
        occurredAt: recordedAt,
        actor: { kind: 'user', id: context.actor.id },
        correlationId: request.id,
        proposalId: request.supplierId,
        actionHash: digest,
        evidenceRefs: [
          request.id,
          request.skuId,
          ...(version.sourceRecordId ? [version.sourceRecordId] : []),
        ],
        details: {
          supplierId: request.supplierId,
          skuId: request.skuId,
          revision: String(version.revision),
          source: version.source,
          reason: request.reason,
        },
      });
      const result = (
        await tx.list({ supplierId: request.supplierId, skuId: request.skuId })
      )[0]!;
      await tx.saveCommand(request.id, digest, result);

      return result;
    });
  }

  return {
    /** Evaluates rollout after refreshing purchasing read authorization. */
    async enabled(context: TenantContext) {
      return deps.released(await authorize(context, false));
    },
    /** Lists visible terms with effective values, their sources and price history. */
    async list(
      context: TenantContext,
      filter: {
        supplierId?: string | undefined;
        skuId?: string | undefined;
      } = {},
    ) {
      context = await authorize(context, false);
      const enabled = await deps.released(context);

      return {
        items: enabled
          ? await deps.store.transaction(context.tenantId, false, (tx) =>
              tx.list(filter),
            )
          : [],
        canManage: enabled && hasPermission(context, 'procurement.manage'),
        enabled,
      };
    },
    /** Adds a revision-checked override and preserves observed values beside it. */
    save(context: TenantContext, input: unknown) {
      return record(context, deps.parse(input));
    },
    /** Records a provider observation through the owner; stale and unchanged reads add no version. */
    observe(
      context: TenantContext,
      input: SupplierTermsInput,
      provenance: Omit<
        SupplierTermsVersion,
        | 'id'
        | 'supplierId'
        | 'skuId'
        | 'revision'
        | 'values'
        | 'recordedAt'
        | 'actorId'
        | 'reason'
      >,
    ) {
      return record(context, deps.parse(input), provenance);
    },
  };
}

export type SupplierTermsService = ReturnType<
  typeof createSupplierTermsService
>;
