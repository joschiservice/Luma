import type { TenantContext } from '@luma/identity';
import {
  IdentityError,
  requireChangesAllowed,
  requirePermission,
  requireTenant,
} from '@luma/identity';

import { exportCsv, exportRowLimit } from '../domain/exports.js';
import type {
  AdaptiveViewPreview,
  AdaptiveViewQuery,
} from '../domain/views.js';

export interface ViewExportRecord {
  id: string;
  tenantId: string;
  actorId: string;
  occurredAt: string;
  domain: string;
  rows: number;
  truncated: boolean;
  columns: readonly string[];
  conditions: number;
}

export interface ViewExportsDependencies {
  /** Reads one authorized page of the query, as previews do. */
  preview(
    context: TenantContext,
    query: AdaptiveViewQuery,
    cursor?: string,
  ): Promise<AdaptiveViewPreview>;
  refreshContext(context: TenantContext): Promise<TenantContext>;
  /** Records that an export happened; the exported values are not stored. */
  record(context: TenantContext, entry: ViewExportRecord): Promise<void>;
  id(): string;
  now(): Date;
}

/**
 * Exports the columns of a list query as CSV. Needs `lists.export` plus the list's own read
 * permission, which every page read checks again; read-only support views cannot export. Rows
 * come from the same owner reads as the list, page by page, up to the export limit; a longer
 * result is cut off and says so in the file and the response.
 */
export function createViewExports(deps: ViewExportsDependencies) {
  return {
    async export(
      context: TenantContext,
      query: AdaptiveViewQuery,
      labels: Readonly<Record<string, string>>,
    ) {
      requireTenant(context, context.tenantId);
      const fresh = await deps.refreshContext(context);
      requireTenant(fresh, context.tenantId);
      if (fresh.actor.id !== context.actor.id)
        throw new IdentityError(403, 'FORBIDDEN', 'Sign in again to continue.');
      requireChangesAllowed(fresh);
      requirePermission(fresh, 'lists.export');
      const rows: Record<string, unknown>[] = [];
      let cursor: string | undefined;
      let columns: string[] = query.state.columns.map((column) => column.id);
      let truncated = false;
      do {
        const page = await deps.preview(fresh, query, cursor);
        if (!columns.length)
          columns = [
            ...new Set(page.items.flatMap((item) => Object.keys(item))),
          ].filter((key) => key !== 'id');
        rows.push(...page.items);
        cursor = page.nextCursor ?? undefined;
        if (rows.length >= exportRowLimit && cursor) truncated = true;
      } while (cursor && !truncated);
      const shown = rows.slice(0, exportRowLimit);
      const readable = columns.filter(
        (id) => shown.some((row) => Object.hasOwn(row, id)) || !shown.length,
      );
      const id = deps.id();
      const occurredAt = deps.now().toISOString();
      await deps.record(fresh, {
        id,
        tenantId: fresh.tenantId,
        actorId: fresh.actor.id,
        occurredAt,
        domain: query.domain,
        rows: shown.length,
        truncated,
        columns: readable,
        conditions: query.state.where.conditions.length,
      });

      return {
        filename: `${query.domain}-${occurredAt.slice(0, 10)}.csv`,
        rows: shown.length,
        truncated,
        csv: exportCsv(
          readable.map((column) => ({
            id: column,
            label: labels[column] ?? column,
          })),
          shown,
          truncated ? labels['@truncated'] : undefined,
        ),
      };
    },
  };
}

export type ViewExports = ReturnType<typeof createViewExports>;
