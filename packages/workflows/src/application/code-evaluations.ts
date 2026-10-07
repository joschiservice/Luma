import type { TenantContext } from '@luma/identity';
import {
  IdentityError,
  requirePermission,
  requireTenant,
} from '@luma/identity';

import type {
  CodeEvaluation,
  EvaluateCode,
} from '../domain/code-evaluation.js';
import { codeOwnedSteps } from '../domain/code-grants.js';
import { CodeRequestStopped, type CodeRunner } from '../domain/code-step.js';
import type { PublishedWorkflowVersion } from '../domain/workflow.js';

/** Persists evaluation reservations and supports cancellation across API instances. */
export interface CodeEvaluationStore {
  get(
    context: TenantContext,
    definitionId: string,
    id: string,
  ): Promise<CodeEvaluation | null>;
  reserve(
    context: TenantContext,
    definitionId: string,
    digest: string,
    item: CodeEvaluation,
  ): Promise<{ item: CodeEvaluation; created: boolean }>;
  finish(
    context: TenantContext,
    definitionId: string,
    item: CodeEvaluation,
  ): Promise<void>;
  cancel(
    context: TenantContext,
    definitionId: string,
    id: string,
  ): Promise<void>;
}

/** Evaluates exact published code against fixture replies, with no production capability adapter. */
export function createCodeEvaluations(deps: {
  store: CodeEvaluationStore;
  runner: CodeRunner;
  version(
    context: TenantContext,
    id: string,
    version: string,
  ): Promise<PublishedWorkflowVersion | null>;
  refreshContext(context: TenantContext): Promise<TenantContext>;
  hash(value: unknown): string;
}) {
  let active = 0;

  async function authorize(context: TenantContext) {
    const fresh = await deps.refreshContext(context);
    requireTenant(fresh, context.tenantId);
    requirePermission(fresh, 'workflows.author');
    if (fresh.actor.id !== context.actor.id)
      throw new IdentityError(403, 'FORBIDDEN', 'Sign in again to continue.');

    return fresh;
  }

  async function get(context: TenantContext, definitionId: string, id: string) {
    const item = await deps.store.get(
      await authorize(context),
      definitionId,
      id,
    );
    if (!item)
      throw new IdentityError(404, 'NOT_FOUND', 'Evaluation not found.');

    return item;
  }

  return {
    get,
    async start(
      context: TenantContext,
      definitionId: string,
      request: EvaluateCode,
    ) {
      context = await authorize(context);
      const version = await deps.version(
        context,
        definitionId,
        request.version,
      );
      if (
        !version ||
        version.format !== 'workflow/2' ||
        version.digest !== request.reviewedDigest
      )
        throw new IdentityError(
          409,
          'CONFLICT',
          'Reload the workflow and review its current version.',
        );
      const step = version.steps.find((item) => item.id === request.stepId);
      if (!step || step.kind !== 'code')
        throw new IdentityError(404, 'NOT_FOUND', 'Code Step not found.');
      if (
        Object.keys(request.replies).some(
          (grant) => !step.grants.includes(grant),
        )
      )
        throw new IdentityError(
          409,
          'CONFLICT',
          'Only declared capabilities may have example replies.',
        );
      for (const [fields, values] of [
        [version.inputs, request.input.inputs],
        [version.context.fields, request.input.evidence],
        [step.fields, request.expected],
      ] as const) {
        if (
          Object.keys(fields).length !== Object.keys(values).length ||
          Object.entries(fields).some(
            ([key, type]) =>
              !Object.hasOwn(values, key) ||
              (values[key] === null ? 'null' : typeof values[key]) !== type,
          )
        )
          throw new IdentityError(
            409,
            'CONFLICT',
            'Example inputs and expected outputs must match the declared fields.',
          );
      }
      const owned = codeOwnedSteps(version);
      const earlier = version.steps
        .slice(0, version.steps.indexOf(step))
        .filter((item) => !owned.has(item.id));
      for (const [id, values] of Object.entries(request.input.steps)) {
        const previous = earlier.find((item) => item.id === id);
        if (!previous)
          throw new IdentityError(
            409,
            'CONFLICT',
            'Example step outputs must name earlier workflow steps.',
          );
        if (
          'fields' in previous &&
          (Object.keys(previous.fields).length !== Object.keys(values).length ||
            Object.entries(previous.fields).some(
              ([key, type]) =>
                !Object.hasOwn(values, key) ||
                (values[key] === null ? 'null' : typeof values[key]) !== type,
            ))
        )
          throw new IdentityError(
            409,
            'CONFLICT',
            'Example step outputs must match their declared fields.',
          );
      }
      for (const [grant, values] of Object.entries(request.replies)) {
        const node = version.steps.find((item) => item.id === grant);
        const reply =
          node?.kind === 'read'
            ? node
            : version.steps.find(
                (item) =>
                  item.kind === 'verification' && item.forStep === grant,
              );
        if (
          !reply ||
          !('fields' in reply) ||
          Object.keys(reply.fields).length !== Object.keys(values).length ||
          Object.entries(reply.fields).some(
            ([key, type]) =>
              !Object.hasOwn(values, key) ||
              (values[key] === null ? 'null' : typeof values[key]) !== type,
          )
        )
          throw new IdentityError(
            409,
            'CONFLICT',
            'Example capability replies must match their declared fields.',
          );
      }
      if (active >= 2)
        throw new IdentityError(
          503,
          'SERVICE_UNAVAILABLE',
          'The evaluator is busy. Try again shortly.',
        );
      const now = new Date();
      const reserved = await deps.store.reserve(
        context,
        definitionId,
        deps.hash(request),
        {
          id: request.id,
          version: request.version,
          stepId: step.id,
          state: 'running',
          createdAt: now.toISOString(),
          expiresAt: new Date(
            now.getTime() + step.limits.wallTimeMs + 5000,
          ).toISOString(),
          result: null,
        },
      );
      if (!reserved.created) return reserved.item;
      active++;
      const stop = new AbortController();
      const poll = setInterval(() => {
        void deps.store
          .get(context, definitionId, request.id)
          .then((item) => {
            if (item?.state !== 'running') stop.abort();
          })
          .catch(() => stop.abort());
      }, 200);
      void (async () => {
        try {
          const result = await deps.runner.run(step, request.input, {
            now: request.now,
            signal: stop.signal,
            async request(grant) {
              await authorize(context);
              if (!Object.hasOwn(request.replies, grant))
                throw new CodeRequestStopped('capability_denied');

              return request.replies[grant];
            },
          });
          await deps.store.finish(context, definitionId, {
            ...reserved.item,
            result,
            state:
              result.telemetry.outcome === 'completed' &&
              deps.hash(result.values) === deps.hash(request.expected)
                ? 'passed'
                : result.telemetry.outcome === 'cancelled'
                  ? 'cancelled'
                  : 'failed',
          });
        } catch {
          await deps.store
            .finish(context, definitionId, {
              ...reserved.item,
              state: 'failed',
            })
            .catch(() => undefined);
        } finally {
          clearInterval(poll);
          stop.abort();
          active--;
        }
      })();

      return reserved.item;
    },
    async cancel(context: TenantContext, definitionId: string, id: string) {
      context = await authorize(context);
      await get(context, definitionId, id);
      await deps.store.cancel(context, definitionId, id);

      return get(context, definitionId, id);
    },
  };
}
