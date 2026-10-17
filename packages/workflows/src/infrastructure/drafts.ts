import type { SqlTransaction, TenantDatabase } from '@luma/platform';
import { conflict } from '@luma/platform';

import type {
  StoredWorkflowDraft,
  WorkflowAuditEntry,
  WorkflowDraftStore,
} from '../application/drafts.js';
import { createWorkflowCatalogStore } from './catalog.js';

type Row = {
  tenant_id: string;
  id: string;
  revision: number;
  state: StoredWorkflowDraft['state'];
  mode: StoredWorkflowDraft['mode'];
  content: StoredWorkflowDraft['content'];
  code_view: string | null;
  based_on: StoredWorkflowDraft['basedOn'];
  author_id: string;
  updated_by: string;
  created_at: Date;
  updated_at: Date;
  published: StoredWorkflowDraft['published'];
  create_digest: string;
  last_save: StoredWorkflowDraft['lastSave'];
};

const columns =
  'tenant_id,id,revision,state,mode,content,code_view,based_on,author_id,updated_by,created_at,updated_at,published,create_digest,last_save';

function present(row: Row): StoredWorkflowDraft {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    revision: row.revision,
    state: row.state,
    mode: row.mode,
    content: row.content,
    codeView: row.code_view,
    basedOn: row.based_on,
    authorId: row.author_id,
    updatedBy: row.updated_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    published: row.published,
    createDigest: row.create_digest,
    lastSave: row.last_save,
  };
}

/**
 * Stores drafts under tenant RLS. Publication and audit share the draft transaction, so a draft is
 * marked published only when its immutable version and audit entry commit.
 */
export function createWorkflowDraftStore(
  db: TenantDatabase,
  audit: (db: TenantDatabase) => {
    append(entry: WorkflowAuditEntry): Promise<void>;
  },
): WorkflowDraftStore {
  const read = async (tx: SqlTransaction, tenantId: string, id: string) => {
    const row = (
      await tx.query<Row>(
        `SELECT ${columns} FROM workflow_drafts WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
        [tenantId, id],
      )
    ).rows[0];

    return row ? present(row) : null;
  };

  return {
    list: (context) =>
      db.transaction(context.tenantId, async (tx) => {
        const rows = await tx.query<Row>(
          `SELECT ${columns} FROM workflow_drafts WHERE tenant_id=$1 AND state='draft' ORDER BY updated_at DESC,id LIMIT 100`,
          [context.tenantId],
        );

        return rows.rows.map(present);
      }),
    get: (context, id) =>
      db.transaction(context.tenantId, async (tx) => {
        const row = (
          await tx.query<Row>(
            `SELECT ${columns} FROM workflow_drafts WHERE tenant_id=$1 AND id=$2`,
            [context.tenantId, id],
          )
        ).rows[0];

        return row ? present(row) : null;
      }),
    transaction: (context, operation) =>
      db.transaction(context.tenantId, async (tx) => {
        const scoped: TenantDatabase = {
          transaction: async (_tenantId, fn) => fn(tx),
        };
        const catalog = createWorkflowCatalogStore(scoped);
        const log = audit(scoped);

        return operation({
          lock: (id) => read(tx, context.tenantId, id),
          async insert(draft) {
            const result = await tx.query(
              `INSERT INTO workflow_drafts(${columns}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT DO NOTHING`,
              [
                context.tenantId,
                draft.id,
                draft.revision,
                draft.state,
                draft.mode,
                draft.content,
                draft.codeView,
                draft.basedOn,
                draft.authorId,
                draft.updatedBy,
                draft.createdAt,
                draft.updatedAt,
                draft.published,
                draft.createDigest,
                draft.lastSave,
              ],
            );

            return result.rowCount === 1;
          },
          async update(draft) {
            await tx.query(
              'UPDATE workflow_drafts SET revision=$3,state=$4,mode=$5,content=$6,code_view=$7,updated_by=$8,updated_at=$9,published=$10,last_save=$11 WHERE tenant_id=$1 AND id=$2',
              [
                context.tenantId,
                draft.id,
                draft.revision,
                draft.state,
                draft.mode,
                draft.content,
                draft.codeView,
                draft.updatedBy,
                draft.updatedAt,
                draft.published,
                draft.lastSave,
              ],
            );
          },
          async publish(version) {
            try {
              await catalog.publish(context, version);
            } catch (error) {
              if (error instanceof Error && /immutable/.test(error.message))
                throw conflict(
                  'Someone published this version or renamed this workflow first. Reload and choose a new version.',
                );
              throw error;
            }
          },
          audit: (entry) => log.append(entry),
        });
      }),
  };
}

/** Lists definitions that cannot be edited as drafts: Resolution and `workflow/1` definitions. */
export function createReservedDefinitions(db: TenantDatabase) {
  return (tenantId: string) =>
    db.transaction(tenantId, async (tx) => {
      const rows = await tx.query<{ definition_id: string }>(
        "SELECT DISTINCT definition_id FROM playbook_versions WHERE tenant_id=$1 AND COALESCE(document->>'format','') <> 'workflow/2'",
        [tenantId],
      );

      return rows.rows.map((row) => row.definition_id);
    });
}
