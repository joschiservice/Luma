import { randomUUID } from 'node:crypto';

import type { SqlTransaction, TenantDatabase } from '@luma/platform';
import { invalid } from '@luma/platform';

import type {
  DetectionRepository,
  Evidence,
  Incident,
} from '../application/detection.js';
import { verificationPostconditions } from '../application/detection.js';
import { identity } from '../domain/evaluate.js';
import type { Configuration } from '../domain/facts.js';
import {
  decimalString,
  decimalUnits,
  inventoryPropagationSeconds,
} from '../domain/facts.js';
import { queueDiagnosis } from './diagnosis-repository.js';

async function lock(tx: SqlTransaction, tenantId: string) {
  // One tenant lock serializes fingerprint, source-key and resolution races together.
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `exceptions:${tenantId}`,
  ]);
}

async function immutable(
  tx: SqlTransaction,
  table: 'exception_configurations' | 'exception_sources' | 'exception_inputs',
  column: 'version' | 'evidence_key',
  tenantId: string,
  key: string,
  document: unknown,
) {
  await tx.query(
    `INSERT INTO ${table}(tenant_id,${column},document) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
    [tenantId, key, document],
  );
  const result = await tx.query<{ matches: boolean }>(
    `SELECT document=$3::jsonb AS matches FROM ${table} WHERE tenant_id=$1 AND ${column}=$2`,
    [tenantId, key, document],
  );
  if (!result.rows[0]?.matches)
    throw new Error('Immutable evidence or configuration key conflict');
}

async function save(tx: SqlTransaction, incident: Incident) {
  await tx.query(
    'UPDATE exceptions SET state=$3,document=$4,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2',
    [incident.tenantId, incident.id, incident.state, incident],
  );
}

async function audit(
  tx: SqlTransaction,
  tenantId: string,
  incidentId: string | null,
  document: unknown,
) {
  await tx.query(
    'INSERT INTO exception_outbox(id,tenant_id,exception_id,document) VALUES($1,$2,$3,$4)',
    [randomUUID(), tenantId, incidentId, document],
  );
}

/**
 * Creates transactional incident and evidence storage with deduplication and revision
 * checks.
 */
export function createDetectionRepository(
  db: TenantDatabase,
): DetectionRepository {
  return {
    verification: (tenantId, incidentId, entry) =>
      db.transaction(tenantId, async (tx) => {
        const attemptId = entry.attemptId ?? randomUUID();
        await audit(tx, tenantId, incidentId, {
          ...entry,
          attemptId,
          type: 'exception.verification_attempt',
        });

        return attemptId;
      }),
    record: (value) =>
      db.transaction(value.request.input.facts.tenantId, async (tx) => {
        const { request, decision, fingerprint, now } = value;
        const { input, configuration, key } = request;
        const tenantId = input.facts.tenantId;
        await lock(tx, tenantId);
        await immutable(
          tx,
          'exception_configurations',
          'version',
          tenantId,
          configuration.version,
          configuration,
        );
        for (const source of request.evidence)
          await immutable(
            tx,
            'exception_sources',
            'evidence_key',
            tenantId,
            source.key,
            source,
          );
        // Thresholds belong to each evaluation, not to immutable source facts.
        const facts = { ...input.facts } as Record<string, unknown>;
        delete facts.tolerance;
        facts.evidenceRefs = [...input.facts.evidenceRefs].sort();
        await immutable(tx, 'exception_inputs', 'evidence_key', tenantId, key, {
          exceptionClass: input.exceptionClass,
          facts,
        });
        const rows = await tx.query<{ document: Incident }>(
          "SELECT document FROM exceptions WHERE tenant_id=$1 AND fingerprint=$2 AND state <> 'resolved'",
          [tenantId, fingerprint],
        );
        let incident = rows.rows[0]?.document ?? null;
        if (incident && incident.configVersion !== configuration.version) {
          incident.configVersion = configuration.version;
          incident.ruleVersion = configuration.ruleVersion;
          await save(tx, incident);
          await audit(tx, tenantId, incident.id, {
            type: 'exception.reevaluated',
            configVersion: configuration.version,
            evidenceKey: key,
            at: now,
          });
        }
        let reviewRequired = false;
        // Waiting for sync is bounded by the rule itself, so it never accumulates uncertainty.
        const waiting =
          decision.decision !== 'defer' ||
          decision.reason !== 'propagation_pending'
            ? null
            : input.exceptionClass === 'inventory_mismatch'
              ? (input.facts.mismatchSince ?? null)
              : input.exceptionClass === 'order_quantity_mismatch'
                ? input.facts.changedAt
                : null;
        // A stalled sync has its own case, so waiting for it is no uncertainty about this one.
        const stalled =
          decision.decision === 'defer' && decision.reason === 'sync_stalled';
        if (decision.decision === 'defer' && !waiting && !stalled) {
          const uncertainty = await tx.query<{
            first_deferred_at: Date;
            review_required: boolean;
          }>(
            `INSERT INTO exception_uncertainty(tenant_id,fingerprint,first_deferred_at) VALUES($1,$2,$3)
     ON CONFLICT(tenant_id,fingerprint) DO UPDATE SET first_deferred_at=COALESCE(exception_uncertainty.first_deferred_at,EXCLUDED.first_deferred_at)
     RETURNING first_deferred_at,review_required`,
            [tenantId, fingerprint, now],
          );
          const row = uncertainty.rows[0]!;
          reviewRequired =
            Date.parse(now) - row.first_deferred_at.getTime() >=
            configuration.thresholds.uncertaintySeconds * 1000;
          if (reviewRequired && !row.review_required) {
            await tx.query(
              'UPDATE exception_uncertainty SET review_required=true WHERE tenant_id=$1 AND fingerprint=$2',
              [tenantId, fingerprint],
            );
            if (incident) {
              incident.state = 'escalated';
              await save(tx, incident);
            }
            await audit(tx, tenantId, incident?.id ?? null, {
              type: 'exception.review_required',
              fingerprint,
              evidenceKey: key,
              reason: decision.reason,
              at: now,
            });
          }
        } else {
          await tx.query(
            'UPDATE exception_uncertainty SET first_deferred_at=NULL,review_required=false WHERE tenant_id=$1 AND fingerprint=$2',
            [tenantId, fingerprint],
          );
        }
        if (waiting) {
          const subject = identity(input);
          await tx.query(
            `INSERT INTO exception_pending_sync(tenant_id,fingerprint,subject_kind,subject_id,scope,mismatch_since,wait_until,evaluated_at)
     VALUES($1,$2,$3,$4,$5,$6,$6::timestamptz+make_interval(secs=>$7),$8)
     ON CONFLICT(tenant_id,fingerprint) DO UPDATE SET subject_kind=EXCLUDED.subject_kind,subject_id=EXCLUDED.subject_id,
      scope=EXCLUDED.scope,mismatch_since=EXCLUDED.mismatch_since,wait_until=EXCLUDED.wait_until,evaluated_at=EXCLUDED.evaluated_at`,
            [
              tenantId,
              fingerprint,
              subject.subjectKind,
              subject.subjectId,
              JSON.stringify(subject.scope),
              waiting,
              input.exceptionClass === 'inventory_mismatch'
                ? inventoryPropagationSeconds(
                    input.facts,
                    configuration.thresholds,
                  )
                : configuration.thresholds.propagationSeconds,
              now,
            ],
          );
        } else
          await tx.query(
            'DELETE FROM exception_pending_sync WHERE tenant_id=$1 AND fingerprint=$2',
            [tenantId, fingerprint],
          );
        if (decision.decision === 'detect') {
          const duplicate = await tx.query<{ document: Incident }>(
            `SELECT e.document FROM exception_evidence ev JOIN exceptions e ON e.tenant_id=ev.tenant_id AND e.id=ev.exception_id
     WHERE ev.tenant_id=$1 AND ev.fingerprint=$2 AND ev.evidence_key=$3`,
            [tenantId, fingerprint, key],
          );
          if (!duplicate.rows.length) {
            const firstDetection = !incident;
            if (!incident) {
              const previous = await tx.query<{ id: string }>(
                "SELECT id FROM exceptions WHERE tenant_id=$1 AND fingerprint=$2 AND state='resolved' ORDER BY updated_at DESC,id DESC LIMIT 1",
                [tenantId, fingerprint],
              );
              incident = {
                id: randomUUID(),
                tenantId,
                fingerprint,
                exceptionClass: input.exceptionClass,
                subject: identity(input),
                severity: decision.severity,
                state: 'detected',
                firstDetectedAt: now,
                lastDetectedAt: now,
                occurrenceCount: 1,
                previousExceptionId: previous.rows[0]?.id ?? null,
                ruleVersion: configuration.ruleVersion,
                configVersion: configuration.version,
              };
              await tx.query(
                'INSERT INTO exceptions(id,tenant_id,fingerprint,state,document,previous_exception_id) VALUES($1,$2,$3,$4,$5,$6)',
                [
                  incident.id,
                  tenantId,
                  fingerprint,
                  incident.state,
                  incident,
                  incident.previousExceptionId,
                ],
              );
            } else {
              incident.occurrenceCount++;
              incident.lastDetectedAt = new Date(
                Math.max(Date.parse(incident.lastDetectedAt), Date.parse(now)),
              ).toISOString();
              if (decision.severity === 'high') incident.severity = 'high';
              incident.ruleVersion = configuration.ruleVersion;
              incident.configVersion = configuration.version;
              await save(tx, incident);
            }
            await tx.query(
              'INSERT INTO exception_evidence(tenant_id,exception_id,evidence_key,fingerprint) VALUES($1,$2,$3,$4)',
              [tenantId, incident.id, key, fingerprint],
            );
            await audit(tx, tenantId, incident.id, {
              type: firstDetection
                ? 'exception.detected'
                : 'exception.observed',
              evidenceKey: key,
              decision,
              at: now,
            });
          } else if (!incident) {
            // Replayed evidence cannot reopen a resolved incident.
            incident = duplicate.rows[0]!.document;
          }
        }
        await tx.query(
          'INSERT INTO exception_evaluations(id,tenant_id,evidence_key,config_version,document) VALUES($1,$2,$3,$4,$5)',
          [
            randomUUID(),
            tenantId,
            key,
            configuration.version,
            {
              decision,
              deliveryKey: request.deliveryKey,
              signedDifference:
                input.exceptionClass === 'inventory_mismatch' &&
                input.facts.leftAvailable !== null &&
                input.facts.rightAvailable !== null
                  ? decimalString(
                      decimalUnits(input.facts.leftAvailable) -
                        decimalUnits(input.facts.rightAvailable),
                    )
                  : null,
              fingerprint,
              at: now,
              ruleVersion: configuration.ruleVersion,
              configVersion: configuration.version,
              reviewRequired,
              incidentId: incident?.id ?? null,
            },
          ],
        );
        if (incident && incident.state !== 'resolved') {
          await queueDiagnosis(
            tx,
            {
              exceptionId: incident.id,
              firstDetectedAt: incident.firstDetectedAt,
              reviewRequired,
              subject: {
                kind: incident.subject.subjectKind,
                id: incident.subject.subjectId,
                scope: incident.subject.scope,
              },
              input,
              configuration,
              evidence: request.evidence,
            },
            now,
          );
        }

        return { decision, incident, reviewRequired };
      }),
    get: (tenantId, incidentId) =>
      db.transaction(tenantId, async (tx) => {
        const result = await tx.query<{ document: Incident; version: number }>(
          'SELECT document,version FROM exceptions WHERE tenant_id=$1 AND id=$2',
          [tenantId, incidentId],
        );
        const row = result.rows[0];

        return row ? { incident: row.document, version: row.version } : null;
      }),
    list: (tenantId) =>
      db.transaction(tenantId, async (tx) =>
        (
          await tx.query<{ document: Incident }>(
            'SELECT document FROM exceptions WHERE tenant_id=$1 ORDER BY created_at,id',
            [tenantId],
          )
        ).rows.map((row) => row.document),
      ),
    evidence: (tenantId, incidentId) =>
      db.transaction(tenantId, async (tx) =>
        (
          await tx.query<{ document: Evidence }>(
            `SELECT DISTINCT s.document FROM exception_evidence e
   JOIN exception_inputs i ON i.tenant_id=e.tenant_id AND i.evidence_key=e.evidence_key
   JOIN exception_sources s ON s.tenant_id=i.tenant_id AND (i.document->'facts'->'evidenceRefs') ? s.evidence_key
   WHERE e.tenant_id=$1 AND e.exception_id=$2`,
            [tenantId, incidentId],
          )
        ).rows.map((row) => row.document),
      ),
    resolve: (tenantId, incidentId, disposition, actorId, now, automationId) =>
      db.transaction(tenantId, async (tx) => {
        await lock(tx, tenantId);
        const found = await tx.query<{ document: Incident; version: number }>(
          'SELECT document,version FROM exceptions WHERE tenant_id=$1 AND id=$2',
          [tenantId, incidentId],
        );
        const incident = found.rows[0]?.document;
        if (!incident) throw new Error('Exception not found');
        if (incident.state === 'resolved')
          throw new Error('Exception already resolved');
        if (disposition.kind === 'verification') {
          if (found.rows[0]!.version !== disposition.incidentVersion)
            throw new Error('Incident changed during verification');
          const subject = incident.subject;
          const bindings = new Map(
            disposition.bindings.map((binding) => [
              binding.evidenceKey,
              binding,
            ]),
          );
          if (
            bindings.size !== disposition.bindings.length ||
            bindings.size !== disposition.evidence.length ||
            disposition.evidence.some((e) => {
              const binding = bindings.get(e.key);
              const connectionMatches =
                incident.exceptionClass === 'sync_failure'
                  ? e.connectionId === subject.subjectId
                  : incident.exceptionClass === 'stuck_fulfillment'
                    ? e.connectionId === subject.scope[0]
                    : incident.exceptionClass === 'inventory_mismatch' ||
                        incident.exceptionClass === 'order_quantity_mismatch'
                      ? e.connectionId !== null &&
                        subject.scope.slice(1).includes(e.connectionId)
                      : incident.exceptionClass === 'stock_sync_stall'
                        ? e.connectionId === subject.subjectId ||
                          e.connectionId === subject.scope[0]
                        : e.connectionId === null;

              return (
                !binding ||
                binding.exceptionClass !== incident.exceptionClass ||
                binding.subject.ruleIdentity !== subject.ruleIdentity ||
                binding.subject.subjectKind !== subject.subjectKind ||
                binding.subject.subjectId !== subject.subjectId ||
                JSON.stringify(binding.subject.scope) !==
                  JSON.stringify(subject.scope) ||
                binding.postcondition !==
                  verificationPostconditions[incident.exceptionClass] ||
                !connectionMatches
              );
            })
          )
            throw new Error(
              'Verification evidence is not bound to the incident postcondition',
            );
          if (
            disposition.fingerprint !== incident.fingerprint ||
            disposition.configVersion !== incident.configVersion
          )
            throw new Error('Verification scope or configuration mismatch');
          const keys = new Set(disposition.evidenceRefs);
          if (
            keys.size !== disposition.evidence.length ||
            disposition.evidence.some(
              (e) => e.tenantId !== tenantId || !keys.has(e.key),
            ) ||
            new Set(disposition.evidence.map((e) => e.key)).size !== keys.size
          )
            throw new Error('Verification evidence mismatch');
          for (const evidence of disposition.evidence)
            await immutable(
              tx,
              'exception_sources',
              'evidence_key',
              tenantId,
              evidence.key,
              evidence,
            );
          const config = await tx.query<{ document: Configuration }>(
            'SELECT document FROM exception_configurations WHERE tenant_id=$1 AND version=$2',
            [tenantId, incident.configVersion],
          );
          const prior = await tx.query<{
            document: { facts: { evidenceRefs: string[] } };
          }>(
            `SELECT i.document FROM exception_evidence e JOIN exception_inputs i ON i.tenant_id=e.tenant_id AND i.evidence_key=e.evidence_key WHERE e.tenant_id=$1 AND e.exception_id=$2`,
            [tenantId, incidentId],
          );
          const oldKeys = new Set(
            prior.rows.flatMap((row) => row.document.facts.evidenceRefs),
          );
          const fresh = disposition.evidence.every(
            (e) =>
              !oldKeys.has(e.key) &&
              Date.parse(e.observedAt) >= Date.parse(incident.lastDetectedAt) &&
              Date.parse(e.observedAt) <= Date.parse(now) &&
              Date.parse(now) - Date.parse(e.observedAt) <=
                config.rows[0]!.document.thresholds.freshnessSeconds * 1000,
          );
          if (
            disposition.outcome !== 'passed' ||
            !disposition.complete ||
            !disposition.authoritative ||
            !fresh
          ) {
            await audit(tx, tenantId, incidentId, {
              type: 'exception.verification_inconclusive',
              verification: disposition,
              actorId,
              at: now,
            });

            return false;
          }
        }
        const refs = await tx.query(
          'SELECT evidence_key FROM exception_sources WHERE tenant_id=$1 AND evidence_key=ANY($2::text[])',
          [tenantId, disposition.evidenceRefs],
        );
        if (refs.rowCount !== new Set(disposition.evidenceRefs).size)
          throw invalid('Resolution evidence not found');
        const auditId = randomUUID();
        const automation = automationId
          ? { id: automationId, name: null }
          : undefined;
        const resolution = {
          ...disposition,
          actorId,
          at: now,
          auditId,
          ...(automation ? { automation } : {}),
        };
        await save(tx, {
          ...incident,
          state: 'resolved',
          resolution,
        });
        await tx.query(
          'INSERT INTO exception_outbox(id,tenant_id,exception_id,document) VALUES($1,$2,$3,$4)',
          [
            auditId,
            tenantId,
            incidentId,
            { type: 'exception.resolved', resolution },
          ],
        );

        return true;
      }),
  };
}
