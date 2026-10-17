import type { TenantDatabase } from '@luma/platform';
import { conflict } from '@luma/platform';

import type {
  GenerationRecord,
  GenerationStore,
} from '../application/draft-generation.js';

type Row = {
  id: string;
  kind: GenerationRecord['kind'];
  draft_id: string | null;
  base_revision: number | null;
  resulting_revision: number | null;
  request_digest: string;
  prompt_version: string;
  prompt_digest: string;
  route: GenerationRecord['route'];
  usage: GenerationRecord['usage'];
  attempts: number;
  outcome: GenerationRecord['outcome'];
  result: GenerationRecord['result'];
  proposal_state: 'open' | 'accepted' | 'rejected' | null;
  decided_by: string | null;
  decided_at: Date | null;
  accept_save_id: string | null;
  created_by: string;
  created_at: Date;
};

const columns =
  'id,kind,draft_id,base_revision,resulting_revision,request_digest,prompt_version,prompt_digest,route,usage,attempts,outcome,result,proposal_state,decided_by,decided_at,accept_save_id,created_by,created_at';

function present(row: Row): GenerationRecord {
  return {
    id: row.id,
    kind: row.kind,
    draftId: row.draft_id,
    baseRevision: row.base_revision,
    resultingRevision: row.resulting_revision,
    requestDigest: row.request_digest,
    promptVersion: row.prompt_version,
    promptDigest: row.prompt_digest,
    route: row.route,
    usage: row.usage,
    attempts: row.attempts,
    outcome: row.outcome,
    result: row.result,
    proposal: row.proposal_state
      ? {
          state: row.proposal_state,
          decidedBy: row.decided_by,
          decidedAt: row.decided_at?.toISOString() ?? null,
          saveId: row.accept_save_id,
        }
      : null,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
  };
}

/** Stores generation provenance under tenant RLS. Records never hold prompts or model text. */
export function createGenerationStore(db: TenantDatabase): GenerationStore {
  return {
    apply: (context, id, decision, save) =>
      db.transaction(context.tenantId, async (tx) => {
        const row = (
          await tx.query<Row>(
            `SELECT ${columns} FROM workflow_generations WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
            [context.tenantId, id],
          )
        ).rows[0];
        if (
          !row?.proposal_state ||
          row.proposal_state === 'rejected' ||
          (row.proposal_state === 'accepted' &&
            row.accept_save_id !== decision.saveId)
        )
          throw conflict('Someone else decided on this change first.');
        if (row.proposal_state === 'accepted') return present(row);
        const revision = await save();
        const updated = (
          await tx.query<Row>(
            `UPDATE workflow_generations SET proposal_state='accepted',decided_by=$3,decided_at=$4,accept_save_id=$5,resulting_revision=$6 WHERE tenant_id=$1 AND id=$2 RETURNING ${columns}`,
            [
              context.tenantId,
              id,
              decision.decidedBy,
              decision.decidedAt,
              decision.saveId,
              revision,
            ],
          )
        ).rows[0];
        if (!updated) throw conflict('The proposal was removed during review.');

        return present(updated);
      }),
    hasUnreleasedImprovement: (context, draftId) =>
      db.transaction(context.tenantId, async (tx) => {
        const result = await tx.query<{ found: boolean }>(
          "SELECT EXISTS(SELECT 1 FROM workflow_generations WHERE tenant_id=$1 AND draft_id=$2 AND proposal_state IN ('open','accepted') AND result->'improvement' IS NOT NULL AND result->'improvement' <> 'null'::jsonb) AS found",
          [context.tenantId, draftId],
        );

        return result.rows[0]?.found === true;
      }),
    get: (context, id) =>
      db.transaction(context.tenantId, async (tx) => {
        const row = (
          await tx.query<Row>(
            `SELECT ${columns} FROM workflow_generations WHERE tenant_id=$1 AND id=$2`,
            [context.tenantId, id],
          )
        ).rows[0];

        return row ? present(row) : null;
      }),
    insert: (context, record) =>
      db.transaction(context.tenantId, async (tx) => {
        const result = await tx.query(
          `INSERT INTO workflow_generations(tenant_id,${columns}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) ON CONFLICT DO NOTHING`,
          [
            context.tenantId,
            record.id,
            record.kind,
            record.draftId,
            record.baseRevision,
            record.resultingRevision,
            record.requestDigest,
            record.promptVersion,
            record.promptDigest,
            JSON.stringify(record.route),
            JSON.stringify(record.usage),
            record.attempts,
            record.outcome,
            record.result === null ? null : JSON.stringify(record.result),
            record.proposal?.state ?? null,
            record.proposal?.decidedBy ?? null,
            record.proposal?.decidedAt ?? null,
            record.proposal?.saveId ?? null,
            record.createdBy,
            record.createdAt,
          ],
        );

        return result.rowCount === 1;
      }),
    list: (context, draftId) =>
      db.transaction(context.tenantId, async (tx) => {
        const rows = await tx.query<Row>(
          `SELECT ${columns} FROM workflow_generations WHERE tenant_id=$1 AND draft_id=$2 ORDER BY created_at DESC,id LIMIT 100`,
          [context.tenantId, draftId],
        );

        return rows.rows.map(present);
      }),
    decide: (context, id, decision) =>
      db.transaction(context.tenantId, async (tx) => {
        const result = await tx.query(
          "UPDATE workflow_generations SET proposal_state=$3,decided_by=$4,decided_at=$5,accept_save_id=$6,resulting_revision=$7 WHERE tenant_id=$1 AND id=$2 AND proposal_state='open'",
          [
            context.tenantId,
            id,
            decision.state,
            decision.decidedBy,
            decision.decidedAt,
            decision.saveId,
            decision.resultingRevision,
          ],
        );

        return result.rowCount === 1;
      }),
  };
}
