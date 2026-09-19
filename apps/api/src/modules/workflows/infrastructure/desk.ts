import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  IdentityError,
  requireRole,
  requireTenant,
} from '#modules/identity/index';
import type { TenantDatabase, SqlTransaction } from '#modules/platform/index';
import type { PolicyService, ProposedAction } from '#modules/policies/index';
import type {
  BoundProposal,
  CaseDecision,
  DecisionReceipt,
  DeskSnapshot,
  DeskStore,
  TimelineEvent,
} from '#modules/workflows/application/desk';

const snapshotSql = `SELECT e.document AS incident,e.version AS revision,d.document AS diagnosis,
 (SELECT jsonb_build_object('action',p.document,'actionHash',p.action_hash,'version',p.version,'diagnosisRevision',p.diagnosis_revision)) AS proposal,
 (SELECT document FROM policy_decisions WHERE tenant_id=e.tenant_id AND proposal_id=p.id AND action_hash=p.action_hash ORDER BY created_at DESC,id DESC LIMIT 1) AS decision,
 (SELECT document FROM policy_approvals WHERE tenant_id=e.tenant_id AND proposal_id=p.id AND action_hash=p.action_hash ORDER BY created_at DESC,id DESC LIMIT 1) AS approval,
 (SELECT x.document FROM executed_actions x JOIN case_proposals cp ON cp.tenant_id=x.tenant_id AND cp.id=x.proposal_id WHERE cp.tenant_id=e.tenant_id AND cp.exception_id=e.id ORDER BY x.created_at DESC,x.id DESC LIMIT 1) AS execution
 FROM exceptions e
 LEFT JOIN exception_diagnosis_heads h ON h.tenant_id=e.tenant_id AND h.exception_id=e.id
 LEFT JOIN exception_diagnoses d ON d.tenant_id=h.tenant_id AND d.exception_id=h.exception_id AND d.revision=h.revision
 LEFT JOIN LATERAL (SELECT * FROM case_proposals WHERE tenant_id=e.tenant_id AND exception_id=e.id ORDER BY diagnosis_revision DESC LIMIT 1) p ON true
 WHERE e.tenant_id=$1 AND e.id=$2`;
async function load(tx: SqlTransaction, tenantId: string, id: string) {
  const row = (
    await tx.query<DeskSnapshot & Record<string, unknown>>(snapshotSql, [
      tenantId,
      id,
    ])
  ).rows[0];
  if (!row) throw new IdentityError(404, 'NOT_FOUND', 'Case not found');
  if (!row.proposal?.action) row.proposal = null;
  return row;
}
async function lock(tx: SqlTransaction, tenantId: string) {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `exceptions:${tenantId}`,
  ]);
}
export function createDeskStore(
  db: TenantDatabase,
  dependencies: {
    policies(db: TenantDatabase): PolicyService;
    parseAction(action: unknown): { action: ProposedAction; hash: string };
    escalate(
      db: TenantDatabase,
      context: import('#modules/identity/index').TenantContext,
      id: string,
      revision: number,
    ): Promise<number>;
  },
): DeskStore {
  return {
    bindWorkflow: (context, id, source) =>
      db.transaction(context.tenantId, async (tx) => {
        requireRole(context, ['owner', 'admin']);
        await load(tx, context.tenantId, id);
        await tx.query(
          'INSERT INTO case_workflows(tenant_id,exception_id,source_kind,source_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
          [context.tenantId, id, source.kind, source.id],
        );
        const match = await tx.query(
          'SELECT 1 FROM case_workflows WHERE tenant_id=$1 AND exception_id=$2 AND source_kind=$3 AND source_id=$4',
          [context.tenantId, id, source.kind, source.id],
        );
        if (!match.rowCount)
          throw new IdentityError(
            409,
            'CONFLICT',
            'Workflow source already belongs to a different case',
          );
      }),
    workflowSource: (context, id) =>
      db.transaction(context.tenantId, async (tx) => {
        const row = (
          await tx.query<{
            source_kind: 'incident' | 'detection';
            source_id: string;
          }>(
            'SELECT source_kind,source_id FROM case_workflows WHERE tenant_id=$1 AND exception_id=$2 ORDER BY created_at DESC,source_kind,source_id LIMIT 1',
            [context.tenantId, id],
          )
        ).rows[0];
        return row ? { kind: row.source_kind, id: row.source_id } : null;
      }),
    withCase: (context, id, write, operation) =>
      db.transaction(context.tenantId, async (tx) => {
        requireTenant(context, context.tenantId);
        if (write) await lock(tx, context.tenantId);
        const snapshot = await load(tx, context.tenantId, id);
        const scoped: TenantDatabase = {
          transaction: async (tenantId, run) => {
            requireTenant(context, tenantId);
            return run(tx);
          },
        };
        return operation({
          snapshot,
          receipt: async (commandId) => {
            const result = await tx.query<{
              request: CaseDecision;
              document: DecisionReceipt;
            }>(
              'SELECT request,document FROM case_commands WHERE tenant_id=$1 AND id=$2',
              [context.tenantId, commandId],
            );
            return result.rows[0]
              ? {
                  request: result.rows[0].request,
                  receipt: result.rows[0].document,
                }
              : null;
          },
          respond: (actor, decisionId, outcome, expiresAt) =>
            dependencies
              .policies(scoped)
              .respond(actor, decisionId, outcome, expiresAt),
          save: async (request, receipt) => {
            await tx.query(
              'INSERT INTO case_commands(tenant_id,id,exception_id,actor_id,request,document) VALUES($1,$2,$3,$4,$5,$6)',
              [
                context.tenantId,
                request.commandId,
                id,
                context.actor.id,
                request,
                receipt,
              ],
            );
          },
          escalate: () =>
            dependencies.escalate(scoped, context, id, snapshot.revision),
        });
      }),
    publish: (context, id, revision, input) =>
      db.transaction(context.tenantId, async (tx) => {
        requireRole(context, ['owner', 'admin']);
        const { action, hash } = dependencies.parseAction(input);
        requireTenant(context, action.tenantId);
        if (
          action.proposedBy.kind !== 'user' ||
          action.proposedBy.id !== context.actor.id
        )
          throw new IdentityError(
            403,
            'FORBIDDEN',
            'Proposal requester must match the authenticated actor',
          );
        await lock(tx, context.tenantId);
        const previous = (
          await tx.query<{
            exception_id: string;
            diagnosis_revision: number;
            action_hash: string;
            document: ProposedAction;
            version: number;
          }>('SELECT * FROM case_proposals WHERE tenant_id=$1 AND id=$2', [
            context.tenantId,
            action.id,
          ])
        ).rows[0];
        if (previous) {
          if (
            previous.exception_id !== id ||
            previous.diagnosis_revision !== revision ||
            previous.action_hash !== hash
          )
            throw new IdentityError(
              409,
              'CONFLICT',
              'Proposal identity is immutable',
            );
          return {
            action: previous.document,
            actionHash: previous.action_hash,
            version: previous.version,
            diagnosisRevision: previous.diagnosis_revision,
          };
        }
        if (
          (
            await tx.query(
              'SELECT 1 FROM executed_actions WHERE tenant_id=$1 AND proposal_id=$2',
              [context.tenantId, action.id],
            )
          ).rowCount
        )
          throw new IdentityError(
            409,
            'CONFLICT',
            'An executed action cannot be attached to a new case',
          );
        const s = await load(tx, context.tenantId, id);
        if (
          s.execution ||
          s.incident.state === 'resolved' ||
          s.incident.state === 'escalated' ||
          s.diagnosis?.revision !== revision ||
          s.diagnosis.status !== 'ready' ||
          action.preconditions.evidenceRefs.some(
            (ref) =>
              !s.diagnosis!.provenance.evidence.some((e) => e.id === ref),
          )
        )
          throw new IdentityError(
            409,
            'CONFLICT',
            'Proposal must reference the current investigation',
          );
        await tx.query(
          'INSERT INTO case_proposals(tenant_id,id,exception_id,diagnosis_revision,action_hash,document) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
          [context.tenantId, action.id, id, revision, hash, action],
        );
        const found = await tx.query<{
          exception_id: string;
          diagnosis_revision: number;
          action_hash: string;
          document: ProposedAction;
          version: number;
        }>('SELECT * FROM case_proposals WHERE tenant_id=$1 AND id=$2', [
          context.tenantId,
          action.id,
        ]);
        const saved = found.rows[0];
        if (
          !saved ||
          saved.action_hash !== hash ||
          saved.exception_id !== id ||
          saved.diagnosis_revision !== revision
        )
          throw new IdentityError(
            409,
            'CONFLICT',
            'An immutable proposal already exists for this investigation',
          );
        return {
          action: saved.document,
          actionHash: saved.action_hash,
          version: saved.version,
          diagnosisRevision: saved.diagnosis_revision,
        } satisfies BoundProposal;
      }),
    proposal: (context, id) =>
      db.transaction(context.tenantId, async (tx) => {
        requireTenant(context, context.tenantId);
        const result = await tx.query<{
          exception_id: string;
          diagnosis_revision: number;
          document: ProposedAction;
        }>(
          `SELECT p.* FROM case_proposals p JOIN exceptions e ON e.tenant_id=p.tenant_id AND e.id=p.exception_id WHERE p.tenant_id=$1 AND p.id=$2 AND e.state NOT IN ('resolved','escalated')`,
          [context.tenantId, id],
        );
        const p = result.rows[0];
        return p
          ? {
              exceptionId: p.exception_id,
              revision: p.diagnosis_revision,
              action: p.document,
            }
          : null;
      }),
    timeline: (context, id, query) =>
      db.transaction(context.tenantId, async (tx) => {
        await load(tx, context.tenantId, id);
        const key = createHash('sha256')
          .update(
            JSON.stringify([
              'case-timeline-v1',
              context.tenantId,
              id,
              query.limit,
            ]),
          )
          .digest('hex');
        let after: { at: string; id: string } | null = null;
        if (query.cursor) {
          try {
            const bytes = Buffer.from(query.cursor, 'base64url');
            if (bytes.toString('base64url') !== query.cursor)
              throw new Error('Encoding');
            const value = z
              .object({
                context: z.string(),
                at: z.string().datetime(),
                id: z.string().uuid(),
              })
              .strict()
              .parse(JSON.parse(bytes.toString()));
            if (value.context !== key) throw new Error('Context');
            after = value;
          } catch {
            throw Object.assign(new Error('Invalid timeline cursor'), {
              statusCode: 400,
            });
          }
        }
        const result = await tx.query<{
          id: string;
          at: string;
          doc: Record<string, unknown>;
        }>(
          `
        WITH proposals AS (SELECT id FROM case_proposals WHERE tenant_id=$1 AND exception_id=$2),
        events AS (
          SELECT 0 AS priority,id,created_at,document AS doc FROM audit_entries WHERE tenant_id=$1 AND proposal_id IN (SELECT id FROM proposals)
          UNION ALL SELECT 1,id,created_at,document FROM execution_outbox WHERE tenant_id=$1 AND proposal_id IN (SELECT id FROM proposals)
          UNION ALL SELECT 2,id,created_at,jsonb_build_object('eventType',document->'type','occurredAt',COALESCE(document->'document'->'evaluatedAt',document->'document'->'createdAt'),'actor',jsonb_build_object('id',COALESCE(document->'document'->'actorId',document->'document'->'approverId')),'proposalId',document->'document'->'proposalId','details',jsonb_build_object('outcome',document->'document'->'outcome')) FROM policy_outbox WHERE tenant_id=$1 AND (document->'document'->>'proposalId')::uuid IN (SELECT id FROM proposals)
          UNION ALL SELECT 3,id,created_at,jsonb_build_object('eventType',document->'type','occurredAt',COALESCE(document->'at',document->'resolution'->'at'),'actor',jsonb_build_object('id',COALESCE(document->'actorId',document->'resolution'->'actorId')),'evidenceRefs',document->'resolution'->'evidenceRefs') FROM exception_outbox WHERE tenant_id=$1 AND exception_id=$2
          UNION ALL SELECT 4,id,created_at,jsonb_build_object('eventType','case.' || (request->>'kind'),'occurredAt',document->'createdAt','actor',jsonb_build_object('id',actor_id),'proposalId',request->'proposalId','details',jsonb_build_object('outcome',request->'kind')) FROM case_commands WHERE tenant_id=$1 AND exception_id=$2
        ), unique_events AS (SELECT DISTINCT ON(id) id,COALESCE((doc->>'occurredAt')::timestamptz,created_at) AS at,doc FROM events ORDER BY id,priority)
        SELECT id,to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,doc FROM unique_events WHERE ($3::timestamptz IS NULL OR (at,id)>($3::timestamptz,$4::uuid)) ORDER BY at,id LIMIT $5`,
          [
            context.tenantId,
            id,
            after?.at ?? null,
            after?.id ?? null,
            query.limit + 1,
          ],
        );
        const rows = result.rows.slice(0, query.limit);
        const items: TimelineEvent[] = rows.map((row) => {
          const d = row.doc;
          const actor = d.actor as { id?: string } | null;
          const details = d.details as {
            outcome?: string;
            state?: string;
          } | null;
          return {
            id: row.id,
            type: String(d.eventType ?? 'case.updated'),
            occurredAt: row.at,
            actorId: actor?.id ?? null,
            proposalId: typeof d.proposalId === 'string' ? d.proposalId : null,
            outcome: details?.outcome ?? details?.state ?? null,
            evidenceRefs: Array.isArray(d.evidenceRefs)
              ? d.evidenceRefs
                  .filter((e): e is string => typeof e === 'string')
                  .slice(0, 100)
              : [],
          };
        });
        const last = items.at(-1);
        return {
          items,
          nextCursor:
            result.rows.length > query.limit && last
              ? Buffer.from(
                  JSON.stringify({
                    context: key,
                    at: last.occurredAt,
                    id: last.id,
                  }),
                ).toString('base64url')
              : null,
        };
      }),
  };
}
