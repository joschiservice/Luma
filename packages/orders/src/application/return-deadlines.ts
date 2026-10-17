import type { AuditEntry } from '@luma/audit';
import type { TenantContext } from '@luma/identity';
import {
  hasPermission,
  requirePermission,
  requireTenant,
} from '@luma/identity';
import {
  conflict,
  forbidden,
  invalid,
  notFound,
  ServiceError,
  unavailable,
} from '@luma/platform';

import type { ReturnAction } from '../domain/return-actions.js';
import type { ReturnCase } from '../domain/return-cases.js';
import type { ExchangeStep } from '../domain/return-exchanges.js';
import {
  type ReturnDeadlinePolicy,
  type ReturnMoneyEvidence,
  type ReturnWaitEpisode,
  returnWaitingConditions,
} from '../domain/return-waiting.js';

/** Read-only provider port; a failed read cannot retire an open waiting occurrence. */
export interface ReturnDeadlineSource {
  money(
    context: TenantContext,
    value: ReturnCase,
    refund: ReturnAction | null,
    exchange: ExchangeStep | null,
  ): Promise<ReturnMoneyEvidence>;
}

/** Transactional owner access; all reads and writes are scoped to the trusted tenant. */
interface ReturnDeadlineTransaction {
  policy(): Promise<ReturnDeadlinePolicy | null>;
  policyCommand(
    id: string,
  ): Promise<{ digest: string; policy: ReturnDeadlinePolicy } | null>;
  insertPolicy(
    policy: ReturnDeadlinePolicy,
    commandId: string,
    digest: string,
  ): Promise<void>;
  lockPolicy(): Promise<void>;
  case(id: string, lock?: boolean): Promise<ReturnCase | null>;
  batch(limit: number, checkedBefore: string): Promise<ReturnCase[]>;
  checkpoint(lastId: string | null): Promise<void>;
  checked(caseId: string, policyRevision: number, at: string): Promise<void>;
  refund(caseId: string): Promise<ReturnAction | null>;
  exchange(caseId: string): Promise<ExchangeStep | null>;
  episodes(caseId: string): Promise<ReturnWaitEpisode[]>;
  episode(id: string): Promise<ReturnWaitEpisode | null>;
  openEpisodes(limit: number): Promise<ReturnWaitEpisode[]>;
  save(value: ReturnWaitEpisode): Promise<void>;
  audit(entry: AuditEntry): Promise<void>;
}

/** Runs one orders-owned transaction without widening tenant authority. */
export interface ReturnDeadlineStore {
  transaction<T>(
    tenantId: string,
    fn: (tx: ReturnDeadlineTransaction) => Promise<T>,
  ): Promise<T>;
}

/** Configures merchant deadlines and persists fresh progress, escalation and recurrence behind tenant authority. */
export function createReturnDeadlines(deps: {
  store: ReturnDeadlineStore;
  source: ReturnDeadlineSource;
  refreshContext(context: TenantContext): Promise<TenantContext>;
  now(): Date;
  uuid(name: string): string;
  digest(value: unknown): string;
}) {
  async function authorize(context: TenantContext, write = false) {
    requireTenant(context, context.tenantId);
    const current = await deps.refreshContext(context);
    requireTenant(current, context.tenantId);
    if (current.actor.id !== context.actor.id)
      throw forbidden('Sign in again to continue');
    requirePermission(current, write ? 'returns.manage' : 'returns.read');

    return current;
  }

  const audit = (
    context: TenantContext,
    id: string,
    event: string,
    facts: Record<string, unknown>,
  ): AuditEntry => ({
    id: deps.uuid(
      `return-wait-audit:${context.tenantId}:${id}:${event}:${deps.digest(facts)}`,
    ),
    tenantId: context.tenantId,
    eventKey: `orders:${event}:${id}:${deps.digest(facts)}`,
    eventType: event,
    schemaVersion: 1,
    occurredAt: deps.now().toISOString(),
    actor: { kind: 'user', id: context.actor.id },
    correlationId: id,
    proposalId: id,
    actionHash: deps.digest(facts),
    evidenceRefs: Array.isArray(facts.evidenceRefs)
      ? facts.evidenceRefs.filter((v): v is string => typeof v === 'string')
      : [],
    details: Object.fromEntries(
      Object.entries(facts).map(([key, value]) => [
        key,
        JSON.stringify(value) ?? 'null',
      ]),
    ),
  });

  async function view(context: TenantContext, caseId: string) {
    return deps.store.transaction(context.tenantId, async (tx) => {
      const c = await tx.case(caseId);
      if (!c) throw notFound('Return case not found');
      const episodes = await tx.episodes(caseId);
      if (episodes.length > 500)
        throw unavailable('Waiting history exceeds this view’s limit');

      return {
        policy: await tx.policy(),
        episodes,
        ownerId: c.assigneeId ?? c.openedBy,
        canManage: hasPermission(context, 'returns.manage'),
        asOf: deps.now().toISOString(),
      };
    });
  }

  async function refresh(context: TenantContext, caseId: string) {
    const data = await deps.store.transaction(context.tenantId, async (tx) => ({
      value: await tx.case(caseId),
      policy: await tx.policy(),
      refund: await tx.refund(caseId),
      exchange: await tx.exchange(caseId),
    }));
    if (!data.value) throw notFound('Return case not found');
    if (!data.policy) return;
    const money =
      data.policy.enabled && data.value.state === 'open' && data.value.proposal
        ? await deps.source
            .money(context, data.value, data.refund, data.exchange)
            .catch(() => ({
              state: 'unknown' as const,
              readable: false,
              complete: false,
              observedAt: null,
              evidenceRefs: [],
              requestedAt:
                data.refund?.requestedAt ?? data.exchange?.requestedAt ?? null,
            }))
        : {
            state: 'unknown' as const,
            readable: false,
            complete: false,
            observedAt: null,
            evidenceRefs: [],
            requestedAt: null,
          };
    const now = deps.now(),
      at = now.toISOString();
    await deps.store.transaction(context.tenantId, async (tx) => {
      await tx.lockPolicy();
      const c = await tx.case(caseId, true),
        policy = await tx.policy();
      if (
        !c ||
        !policy ||
        c.revision !== data.value!.revision ||
        policy.revision !== data.policy!.revision
      )
        throw conflict(
          'The case or deadlines changed during the read. Check again.',
        );
      const result = returnWaitingConditions(c, policy, money, now),
        existing = await tx.episodes(caseId),
        ownerId = c.assigneeId ?? c.openedBy;
      if (existing.length > 500)
        throw unavailable('Waiting history exceeds this view’s limit');
      for (const old of existing.filter((e) =>
        ['waiting', 'escalated'].includes(e.state),
      )) {
        const matching = result.conditions.find(
          (p) =>
            p.phase === old.phase &&
            p.anchorAt === old.anchorAt &&
            old.policyRevision === policy.revision,
        );
        if (matching) continue;
        const state =
          !policy.enabled || c.state !== 'open'
            ? 'paused'
            : old.policyRevision !== policy.revision
              ? 'superseded'
              : result.verified.includes(old.phase)
                ? 'verified'
                : 'superseded';
        const next = {
          ...old,
          state,
          ownerId,
          updatedAt: at,
          endedAt: at,
          ...(state === 'verified'
            ? {
                observedAt:
                  old.phase === 'financial' ? money.observedAt : c.updatedAt,
                evidenceRefs:
                  old.phase === 'financial'
                    ? money.evidenceRefs
                    : [`case:${c.id}:${c.revision}`],
              }
            : {}),
        } satisfies ReturnWaitEpisode;
        await tx.save(next);
        await tx.audit(
          audit(context, next.id, `return.wait.${state}`, {
            caseId,
            phase: next.phase,
            ownerId,
            evidenceRefs: money.evidenceRefs,
            observedAt: money.observedAt,
          }),
        );
      }
      for (const condition of result.conditions) {
        const related = existing.filter(
          (e) =>
            e.phase === condition.phase &&
            e.anchorAt === condition.anchorAt &&
            e.policyRevision === policy.revision,
        );
        const current = related.find((e) =>
          ['waiting', 'escalated'].includes(e.state),
        );
        const occurrence =
          current?.occurrence ??
          Math.max(0, ...related.map((e) => e.occurrence)) + 1;
        const state =
          Date.parse(condition.dueAt) <= +now ? 'escalated' : 'waiting';
        const next: ReturnWaitEpisode = {
          ...condition,
          id:
            current?.id ??
            deps.uuid(
              `return-wait:${context.tenantId}:${caseId}:${condition.phase}:${condition.anchorAt}:${policy.revision}:${occurrence}`,
            ),
          tenantId: context.tenantId,
          caseId,
          orderId: c.orderId,
          connectionId: c.connectionId,
          policyRevision: policy.revision,
          occurrence,
          state,
          ownerId,
          openedAt: current?.openedAt ?? at,
          updatedAt: at,
          endedAt: null,
        };
        await tx.save(next);
        if (
          !current ||
          current.state !== state ||
          current.reason !== condition.reason
        )
          await tx.audit(
            audit(context, next.id, `return.wait.${state}`, {
              caseId,
              phase: next.phase,
              ownerId,
              reason: next.reason,
              dueAt: next.dueAt,
              occurrence: next.occurrence,
              evidenceRefs: next.evidenceRefs,
              observedAt: next.observedAt,
            }),
          );
      }
      await tx.checked(caseId, policy.revision, at);
    });
  }

  return {
    /** Reads deadline configuration without reading any provider. */
    async policy(context: TenantContext) {
      context = await authorize(context);

      return {
        policy: await deps.store.transaction(context.tenantId, (tx) =>
          tx.policy(),
        ),
        canManage: hasPermission(context, 'returns.manage'),
      };
    },
    /** Appends one reviewed configuration version; exact command retries retain the original version. */
    async configure(
      context: TenantContext,
      input: {
        commandId: string;
        expectedRevision: number;
        enabled: boolean;
        receiptHours: number;
        inspectionHours: number;
        financialHours: number;
        sourceMaxAgeSeconds: number;
      },
    ) {
      context = await authorize(context, true);
      if (
        [input.receiptHours, input.inspectionHours, input.financialHours].some(
          (n) => !Number.isSafeInteger(n) || n < 1 || n > 2160,
        ) ||
        !Number.isSafeInteger(input.sourceMaxAgeSeconds) ||
        input.sourceMaxAgeSeconds < 30 ||
        input.sourceMaxAgeSeconds > 300
      )
        throw invalid(
          'Choose whole hours between 1 and 2160. Source freshness must be between 30 and 300 seconds.',
        );
      const digest = deps.digest([context.actor.id, input]);

      return deps.store.transaction(context.tenantId, async (tx) => {
        await tx.lockPolicy();
        const old = await tx.policyCommand(input.commandId);
        if (old) {
          if (old.digest !== digest)
            throw conflict('This command was used for different deadlines');

          return { policy: old.policy, canManage: true };
        }
        const current = await tx.policy();
        if ((current?.revision ?? 0) !== input.expectedRevision)
          throw conflict('Deadlines changed. Reload before saving.');
        const { commandId, expectedRevision, ...settings } = input;
        const policy: ReturnDeadlinePolicy = {
          ...settings,
          revision: expectedRevision + 1,
          updatedBy: context.actor.id,
          updatedAt: deps.now().toISOString(),
        };
        await tx.insertPolicy(policy, commandId, digest);
        await tx.audit(
          audit(context, commandId, 'return.deadlines.configured', {
            revision: policy.revision,
            ...settings,
          }),
        );

        return { policy, canManage: true };
      });
    },
    /** Reads durable waits and their earlier occurrences; it never refreshes provider evidence. */
    async get(context: TenantContext, caseId: string) {
      return view(await authorize(context), caseId);
    },
    /** Explicitly rereads progress without executing an external action. */
    async check(context: TenantContext, caseId: string) {
      context = await authorize(context, true);
      await refresh(context, caseId);

      return view(context, caseId);
    },
    /** A bounded background pass; a persisted cursor prevents busy or old cases starving other cases. */
    async tick(context: TenantContext) {
      context = await authorize(context);
      const cases = await deps.store.transaction(context.tenantId, (tx) =>
        tx.batch(26, new Date(+deps.now() - 60_000).toISOString()),
      );
      for (const c of cases.slice(0, 25)) {
        try {
          await refresh(context, c.id);
        } catch (error) {
          if (
            !(error instanceof ServiceError) ||
            ![404, 409, 503].includes(error.statusCode)
          )
            throw error;
        }
      }
      await deps.store.transaction(context.tenantId, (tx) =>
        tx.checkpoint(cases.length > 25 ? cases[24]!.id : null),
      );
    },
    /** Supplies bounded persisted attention to the case owner and workflow signal reader. */
    async pending(context: TenantContext) {
      context = await authorize(context);
      const values = await deps.store.transaction(context.tenantId, (tx) =>
        tx.openEpisodes(501),
      );
      if (values.length > 500)
        throw unavailable(
          'Return waiting attention exceeds this view’s limit. Review cases from their orders.',
        );

      return values;
    },
    /** Reads one immutable occurrence, including its verified or superseded end state. */
    async occurrence(context: TenantContext, id: string) {
      context = await authorize(context);

      return deps.store.transaction(context.tenantId, (tx) => tx.episode(id));
    },
  };
}

export type ReturnDeadlines = ReturnType<typeof createReturnDeadlines>;
