import { createHash } from 'node:crypto';

import type { AuthorityReader, CapabilityReader } from '@luma/connections';
import type { DiagnosisRereader } from '@luma/exceptions';
import {
  createDiagnoses,
  createExceptions,
} from '@luma/exceptions/composition';
import type { IdentityService, TenantContext } from '@luma/identity';
import {
  requireChangesAllowed,
  requirePermission,
  requireTenant,
} from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';
import { createDiagnosisRereader } from '@luma/resolution';
import {
  activeDiagnosisPublication,
  createDetectionSources,
  planActiveDiagnosis,
} from '@luma/resolution/composition';

import { createCommerceServices } from './services.js';

const cooldownMs = 15 * 60_000;

/** Releases the database investigation lease promptly even when a connector ignores cancellation. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted)
    return Promise.reject(new Error('Investigation cancelled'));

  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(new Error('Investigation cancelled'));
    signal.addEventListener('abort', stop, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', stop);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', stop);
        reject(error);
      },
    );
  });
}

/**
 * Wires active diagnosis to scoped provider reads and atomic owner publication. The tenant flag
 * defaults off; current permissions are refreshed before every read and publication. One incident
 * has one investigation at a time, at most two provider calls and a retained 15-minute cooldown.
 */
export function createActiveDiagnosisRereader(options: {
  database: TenantDatabase;
  reader: CapabilityReader | undefined;
  identity: Pick<IdentityService, 'refreshContext'>;
  enabled(tenantId: string): Promise<boolean>;
  now?: () => Date;
  authority?: AuthorityReader;
}): DiagnosisRereader | undefined {
  if (!options.reader) return undefined;
  const reader = options.reader;
  const now = options.now ?? (() => new Date());
  const hash = (value: string) =>
    createHash('sha256').update(value).digest('hex');

  async function authorized(context: TenantContext) {
    const fresh = await options.identity.refreshContext(context);
    requireTenant(fresh, context.tenantId);
    if (fresh.actor.id !== context.actor.id)
      throw new Error('Investigation principal changed');
    requirePermission(fresh, 'issues.manage');
    requireChangesAllowed(fresh);

    return fresh;
  }

  return {
    async read(context, snapshot, signal) {
      context = await authorized(context);
      signal.throwIfAborted();
      if (!(await options.enabled(context.tenantId)))
        return { status: 'unavailable', retryAfter: null };
      // A revision already contains the authoritative experiment. Evaluate it without another
      // round of provider reads; otherwise every newly published mismatch would recurse forever.
      const retained = snapshot.evidence.find(
        (entry) =>
          entry.adapterVersion === 'diagnosis-investigation-v1' &&
          entry.tenantId === context.tenantId &&
          entry.connectionId === null &&
          entry.source === null &&
          entry.facts.incidentId === snapshot.exceptionId,
      );
      if (retained) {
        const advice = retained.facts.retryAfterMs;
        const retryAt =
          typeof advice === 'number' && Number.isFinite(advice) && advice > 0
            ? Date.parse(retained.observedAt) + advice
            : null;

        return {
          status: 'completed',
          retryAfter:
            retryAt !== null && Number.isFinite(retryAt)
              ? new Date(retryAt).toISOString()
              : null,
        };
      }

      return options.database.transaction(context.tenantId, async (tx) => {
        signal.throwIfAborted();
        const lock = (
          await tx.query<{ admitted: boolean }>(
            'SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS admitted',
            [
              `diagnosis-investigation:${context.tenantId}:${snapshot.exceptionId}`,
            ],
          )
        ).rows[0];
        if (!lock?.admitted)
          return {
            status: 'rate_limited' as const,
            retryAfter: new Date(now().getTime() + 5000).toISOString(),
          };
        const scoped: TenantDatabase = {
          transaction: async (tenantId, operation) => {
            requireTenant(context, tenantId);
            signal.throwIfAborted();
            const value = await operation(tx);
            signal.throwIfAborted();

            return value;
          },
        };
        const budget = await createDiagnoses(scoped, now).investigationBudget(
          context,
          snapshot.exceptionId,
        );
        const completedAt = budget ? Date.parse(budget.completedAt) : null;
        const notBefore =
          completedAt !== null && Number.isFinite(completedAt)
            ? completedAt + Math.max(cooldownMs, budget?.retryAfterMs ?? 0)
            : 0;
        if (now().getTime() < notBefore)
          return {
            status: 'rate_limited' as const,
            retryAfter: new Date(notBefore).toISOString(),
          };
        const boundedReader: CapabilityReader = {
          discover: async (acting, connectionId) =>
            reader.discover(await authorized(acting), connectionId),
          read: async (acting, request) => {
            signal.throwIfAborted();
            if (!(await options.enabled(acting.tenantId)))
              throw new Error('Investigation release was disabled');
            const result = await untilAborted(
              reader.read(await authorized(acting), request),
              signal,
            );
            signal.throwIfAborted();

            return result;
          },
        };
        const investigation = createDiagnosisRereader(
          boundedReader,
          {
            plan: async (acting, input) =>
              planActiveDiagnosis(acting, input, boundedReader),
            publish: async (acting, input, pages, abort) => {
              abort.throwIfAborted();
              acting = await authorized(acting);
              if (!(await options.enabled(acting.tenantId)))
                throw new Error('Investigation release was disabled');
              const currentDiagnosis = await createDiagnoses(scoped, now).get(
                acting,
                input.exceptionId,
              );
              const currentIncident = await createExceptions(scoped, now).get(
                acting,
                input.exceptionId,
              );
              if (
                !currentDiagnosis ||
                !currentIncident ||
                currentIncident.state === 'resolved' ||
                currentDiagnosis.revision !== input.revision
              )
                throw new Error(
                  'Investigation was superseded before publication',
                );
              const publication = activeDiagnosisPublication(
                acting,
                input,
                pages,
                now(),
                hash,
              );
              if (!publication)
                throw new Error(
                  'Investigation did not uniquely observe its mapped subject',
                );
              if (
                input.input.exceptionClass === 'inventory_mismatch' &&
                options.authority
              ) {
                const current = await options.authority.read(acting);
                const captured = input.evidence.find(
                  (entry) => 'sourceAuthority' in entry.facts,
                )?.facts.sourceAuthority;
                if (
                  captured &&
                  typeof captured === 'object' &&
                  'revision' in captured &&
                  captured.revision !== current.revision
                )
                  throw new Error('Investigation source authority changed');
                const facts = input.input.facts;
                if (
                  facts.authority !== null &&
                  (current.groups.find(
                    (group) => group.group === 'inventory_stock',
                  )?.connectionId !==
                    facts.connectionIds[facts.authority === 'left' ? 0 : 1] ||
                    current.groups.find(
                      (group) => group.group === 'inventory_selling',
                    )?.connectionId !==
                      facts.connectionIds[
                        facts.sellingSource === 'left' ? 0 : 1
                      ])
                )
                  throw new Error('Investigation source authority changed');
              }
              const commerce = createCommerceServices(scoped);
              let projected = publication.observations.length > 0;
              const entities = new Set<string>();
              for (const observation of publication.observations) {
                abort.throwIfAborted();
                const result = await commerce.ingestion.ingest(
                  acting,
                  `investigation:${observation.observation.id}`,
                  observation,
                );
                if (result.status !== 'applied') projected = false;
                if (result.status === 'applied') entities.add(result.entityId);
              }
              if (
                publication.request.input.exceptionClass ===
                'inventory_mismatch'
              ) {
                const facts = publication.request.input.facts;
                const positions = await createDetectionSources(
                  scoped,
                ).stockPositions(acting, {
                  include: [
                    {
                      skuId: facts.subjectId,
                      locationId: facts.canonicalLocationId,
                    },
                  ],
                  limit: 1,
                });
                const matches = positions.filter(
                  (position) =>
                    !position.nativeOwned &&
                    position.skuId === facts.subjectId &&
                    position.locationId === facts.canonicalLocationId &&
                    publication.observations.every(
                      (read) =>
                        read.capability === 'inventory.read' &&
                        position.sources.filter(
                          (entry) =>
                            entry.connectionId ===
                              read.observation.source.connectionId &&
                            entry.sku.externalId ===
                              read.observation.data.sku.externalId &&
                            entry.sku.scopeKey ===
                              read.observation.data.sku.scopeKey &&
                            entry.location.externalId ===
                              read.observation.data.location.externalId &&
                            entry.location.scopeKey ===
                              read.observation.data.location.scopeKey,
                        ).length === 1,
                    ),
                );
                facts.projectionCurrent =
                  projected &&
                  entities.size === 1 &&
                  matches.length === 1 &&
                  entities.has(matches[0]!.positionId);
              }
              abort.throwIfAborted();
              const outcome = await createExceptions(scoped, now).ingest(
                acting,
                publication.request,
              );
              if (outcome.decision.decision === 'reject')
                throw new Error('Investigation publication was rejected');
              abort.throwIfAborted();
            },
          },
          now,
        );
        const outcome = await investigation.read(context, snapshot, signal);
        signal.throwIfAborted();

        return outcome;
      });
    },
  };
}
