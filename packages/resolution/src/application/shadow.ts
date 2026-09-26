import type { TenantContext } from '@luma/identity';
import { IdentityError, requireRole, requireTenant } from '@luma/identity';
import type { PlaybookRun } from '@luma/workflows';

import type {
  ShadowComparison,
  ShadowEvaluation,
  ShadowReview,
} from '../application/shadow-evaluation.js';
import { shadowMetrics } from '../domain/shadow.js';
import { evaluateShadow } from './shadow-evaluation.js';

export interface ShadowRequest {
  id: string;
  workflow: string;
}

export interface ShadowStore {
  /** Locks the evaluation ID and retains one immutable snapshot; exact retries reuse it. */
  evaluate(
    context: TenantContext,
    incidentId: string,
    request: ShadowRequest,
    evaluate: (
      source: Pick<
        Parameters<typeof evaluateShadow>[0],
        'diagnosis' | 'candidate' | 'version' | 'available'
      >,
    ) => ShadowEvaluation,
    candidate?: PlaybookRun | null,
  ): Promise<ShadowEvaluation>;
  /** Records one evidence-backed operator comparison; conflicting retries fail. */
  review(
    context: TenantContext,
    id: string,
    review: ShadowReview,
  ): Promise<void>;
  /** Returns up to 500 incident comparisons in one bounded workflow and time window. */
  list(
    context: TenantContext,
    workflow: string,
    since: string,
    until: string,
    incidentId?: string,
  ): Promise<ShadowComparison[]>;
}

/** Creates Shadow commands with fresh tenant authorization and no execution or provider-write dependency. */
export function createShadowService(deps: {
  store: ShadowStore;
  refreshContext(context: TenantContext): Promise<TenantContext>;
  parseRequest(input: unknown): ShadowRequest;
  parseReview(input: unknown): ShadowReview;
  parseId(input: string): string;
  parseWindow(input: unknown): {
    workflow: string;
    since: string;
    until: string;
  };
  sameAction(
    a: ShadowReview['operatorAction'],
    b: ShadowReview['operatorAction'],
  ): boolean;
  now(): Date;
}) {
  async function authorize(context: TenantContext) {
    const fresh = await deps.refreshContext(context);
    requireTenant(fresh, context.tenantId);
    requireRole(fresh, ['owner', 'admin']);
    if (fresh.actor.id !== context.actor.id)
      throw new IdentityError(403, 'FORBIDDEN', 'Actor changed');

    return fresh;
  }

  return {
    /** Reads the latest retained comparison for one case and Playbook. */
    async latest(context: TenantContext, incidentId: string, workflow: string) {
      context = await authorize(context);
      const window = deps.parseWindow({
        workflow,
        since: '1970-01-01T00:00:00.000Z',
        until: new Date(deps.now().getTime() + 1).toISOString(),
      });
      const items = await deps.store.list(
        context,
        window.workflow,
        window.since,
        window.until,
        deps.parseId(incidentId),
      );

      return { item: items[0] ?? null };
    },
    /** Records the current proposal and conditional simulation; exact retries reuse the snapshot. */
    async evaluate(
      context: TenantContext,
      incidentId: string,
      input: unknown,
      candidate?: PlaybookRun | null,
    ) {
      context = await authorize(context);
      const request = deps.parseRequest(input);
      incidentId = deps.parseId(incidentId);

      return deps.store.evaluate(
        context,
        incidentId,
        request,
        (source) =>
          evaluateShadow({
            ...source,
            ...request,
            incidentId,
            actorId: context.actor.id,
            role: context.actor.role,
            now: deps.now().toISOString(),
          }),
        candidate,
      );
    },
    /** Retains the first incident-evidence-backed operator comparison. */
    async review(context: TenantContext, id: string, input: unknown) {
      context = await authorize(context);
      const review = deps.parseReview(input);
      if (Date.parse(review.occurredAt) > deps.now().getTime())
        throw new IdentityError(
          409,
          'CONFLICT',
          'Observation time is in the future',
        );
      await deps.store.review(context, deps.parseId(id), review);

      return { recorded: true as const };
    },
    /** Compares the latest evaluation per incident with observed actions and compatible outcomes. */
    async report(context: TenantContext, input: unknown) {
      context = await authorize(context);
      const window = deps.parseWindow(input);
      const items = await deps.store.list(
        context,
        window.workflow,
        window.since,
        window.until,
      );
      if (items.length > 500)
        throw new IdentityError(
          409,
          'CONFLICT',
          'Narrow the report window to at most 500 incidents',
        );

      return {
        mode: 'shadow' as const,
        ...window,
        items,
        metrics: shadowMetrics(items, deps.sameAction),
      };
    },
  };
}

export type ShadowService = ReturnType<typeof createShadowService>;
