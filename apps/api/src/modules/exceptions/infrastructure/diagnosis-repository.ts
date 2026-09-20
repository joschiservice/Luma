import { createHash } from 'node:crypto';

import type { DiagnosisRepository } from '#modules/exceptions/application/diagnosis';
import type {
  Diagnosis,
  DiagnosisInput,
} from '#modules/exceptions/domain/diagnosis';
import {
  diagnose,
  diagnosisVersion,
} from '#modules/exceptions/domain/diagnosis';
import type { SqlTransaction, TenantDatabase } from '#modules/platform/index';

/** Called under the detection tenant lock, so pending state commits with its evidence. */
export async function queueDiagnosis(
  tx: SqlTransaction,
  snapshot: Omit<DiagnosisInput, 'revision'>,
  now: string,
) {
  const tenantId = snapshot.input.facts.tenantId;
  const current = await tx.query<{
    snapshot: DiagnosisInput;
    evidence_time: Date;
  }>(
    `SELECT d.snapshot,h.evidence_time FROM exception_diagnosis_heads h JOIN exception_diagnoses d USING(tenant_id,exception_id,revision) WHERE h.tenant_id=$1 AND h.exception_id=$2`,
    [tenantId, snapshot.exceptionId],
  );
  const previous = current.rows[0];
  const configurationChanged =
    previous !== undefined &&
    previous.snapshot.configuration.version !== snapshot.configuration.version;
  const times = snapshot.evidence
    .filter((e) => e.adapterVersion !== 'canonical-mapping-v1')
    .map((e) => Date.parse(e.observedAt));
  let evidenceTime = new Date(
    Math.min(Date.parse(now), Math.max(...times, 0)),
  ).toISOString();
  if (previous && Date.parse(evidenceTime) < previous.evidence_time.getTime()) {
    if (!configurationChanged) return;
    // A configuration change reevaluates the newest evidence, even if its delivery carries an old observation.
    const input = structuredClone(previous.snapshot.input);
    if (input.exceptionClass === 'inventory_mismatch')
      input.facts.tolerance = snapshot.configuration.inventoryTolerance;
    snapshot = {
      ...previous.snapshot,
      input,
      configuration: snapshot.configuration,
    };
    evidenceTime = previous.evidence_time.toISOString();
  }
  const material = JSON.stringify([
    [...snapshot.input.facts.evidenceRefs].sort(),
    snapshot.configuration.version,
    diagnosisVersion,
    snapshot.reviewRequired,
    diagnose({ ...snapshot, revision: 1 }, now).detectorDecision,
  ]);
  let revisionKey = createHash('sha256').update(material).digest('hex');
  const existing = await tx.query<{ revision: number }>(
    'SELECT revision FROM exception_diagnoses WHERE tenant_id=$1 AND exception_id=$2 AND revision_key=$3',
    [tenantId, snapshot.exceptionId, revisionKey],
  );
  if (existing.rowCount) {
    if (!configurationChanged) return;
    // Restoring a prior configuration still needs a new investigation, not an old recommendation.
    revisionKey = createHash('sha256')
      .update(JSON.stringify([material, previous!.snapshot.revision]))
      .digest('hex');
  }
  const head = await tx.query<{ revision: number }>(
    `INSERT INTO exception_diagnosis_heads(tenant_id,exception_id,revision,evidence_time) VALUES($1,$2,1,$3)
    ON CONFLICT(tenant_id,exception_id) DO UPDATE SET revision=exception_diagnosis_heads.revision+1,evidence_time=EXCLUDED.evidence_time
    WHERE exception_diagnosis_heads.evidence_time<=EXCLUDED.evidence_time RETURNING revision`,
    [tenantId, snapshot.exceptionId, evidenceTime],
  );
  if (!head.rows[0]) return;
  const input = { ...snapshot, revision: head.rows[0].revision };
  const document = diagnose(input, now);
  document.status = 'pending';
  document.reason = 'investigation_pending';
  // Findings are published only when investigation completes.
  document.facts = [];
  document.hypotheses = [];
  document.nextSteps = [];
  document.impact = {
    observed: [],
    potential: [],
    exposedQuantity: null,
    unit: null,
    cost: null,
  };
  document.summary = 'Investigation is pending.';
  await tx.query(
    'INSERT INTO exception_diagnoses(tenant_id,exception_id,revision,revision_key,snapshot,document) VALUES($1,$2,$3,$4,$5,$6)',
    [
      tenantId,
      snapshot.exceptionId,
      input.revision,
      revisionKey,
      input,
      document,
    ],
  );
}

/**
 * Creates tenant-scoped access to current and historical diagnoses and revision-checked
 * completion.
 */
export function createDiagnosisRepository(
  db: TenantDatabase,
): DiagnosisRepository {
  return {
    current: (tenantId, exceptionId) =>
      db.transaction(tenantId, async (tx) => {
        const result = await tx.query<{
          snapshot: DiagnosisInput;
          document: Diagnosis;
          resolved: boolean;
        }>(
          `SELECT d.snapshot,d.document,e.state='resolved' AS resolved FROM exception_diagnosis_heads h
      JOIN exception_diagnoses d USING(tenant_id,exception_id,revision) JOIN exceptions e ON e.tenant_id=h.tenant_id AND e.id=h.exception_id
      WHERE h.tenant_id=$1 AND h.exception_id=$2`,
          [tenantId, exceptionId],
        );

        return result.rows[0] ?? null;
      }),
    history: (tenantId, exceptionId) =>
      db.transaction(tenantId, async (tx) =>
        (
          await tx.query<{ document: Diagnosis }>(
            `SELECT jsonb_set(d.document,'{superseded}',to_jsonb(d.revision<>h.revision OR e.state='resolved')) AS document FROM exception_diagnoses d
      JOIN exception_diagnosis_heads h USING(tenant_id,exception_id) JOIN exceptions e ON e.tenant_id=d.tenant_id AND e.id=d.exception_id
      WHERE d.tenant_id=$1 AND d.exception_id=$2 ORDER BY d.revision`,
            [tenantId, exceptionId],
          )
        ).rows.map((r) => r.document),
      ),
    complete: (tenantId, document) =>
      db.transaction(tenantId, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `exceptions:${tenantId}`,
        ]);
        const result = await tx.query(
          `UPDATE exception_diagnoses d SET document=$4 FROM exception_diagnosis_heads h,exceptions e
      WHERE d.tenant_id=$1 AND d.exception_id=$2 AND d.revision=$3 AND h.tenant_id=d.tenant_id AND h.exception_id=d.exception_id AND h.revision=d.revision
      AND e.tenant_id=d.tenant_id AND e.id=d.exception_id AND e.state<>'resolved' AND d.document->>'status' IN ('pending','failed')`,
          [tenantId, document.exceptionId, document.revision, document],
        );

        return result.rowCount === 1;
      }),
  };
}
