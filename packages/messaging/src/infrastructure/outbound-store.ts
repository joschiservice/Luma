import type { SqlTransaction } from '@luma/platform';
import { conflict } from '@luma/platform';

import type { OutboundRepository, OutboundRow } from '../application/store.js';

type Row = Record<string, unknown>;

const iso = (value: unknown) =>
  value instanceof Date ? value.toISOString() : (value as string);

function outbound(row: Row): OutboundRow {
  return {
    id: row.id as string,
    threadId: row.thread_id as string,
    connectionId: row.connection_id as string,
    document: row.document as OutboundRow['document'],
    state: row.state as OutboundRow['state'],
    actionId: (row.action_id as string | null) ?? null,
    requestedBy: row.requested_by as string,
    revision: row.revision as number,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

/** Stores replies in the caller's tenant transaction. */
export function outboundRepository(
  tx: SqlTransaction,
  tenantId: string,
): OutboundRepository {
  const rows = async (sql: string, values: unknown[]) =>
    (await tx.query<Row>(sql, values)).rows;

  return {
    async forThread(threadId) {
      return (
        await rows(
          'SELECT * FROM messaging_outbound WHERE tenant_id=$1 AND thread_id=$2 ORDER BY created_at,id',
          [tenantId, threadId],
        )
      ).map(outbound);
    },
    async get(id, lock = false) {
      const [row] = await rows(
        `SELECT * FROM messaging_outbound WHERE tenant_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`,
        [tenantId, id],
      );

      return row ? outbound(row) : null;
    },
    async insert(o) {
      try {
        await tx.query(
          `INSERT INTO messaging_outbound(tenant_id,id,thread_id,connection_id,document,state,action_id,requested_by,
          revision,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            tenantId,
            o.id,
            o.threadId,
            o.connectionId,
            o.document,
            o.state,
            o.actionId,
            o.requestedBy,
            o.revision,
            o.createdAt,
            o.updatedAt,
          ],
        );
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === '23505'
        )
          throw conflict(
            'A submission already exists for this order. Refresh the Operations Inbox before drafting again.',
          );
        throw error;
      }
    },
    async update(o) {
      await tx.query(
        `UPDATE messaging_outbound SET document=$3,state=$4,action_id=$5,revision=$6,updated_at=$7
        WHERE tenant_id=$1 AND id=$2`,
        [
          tenantId,
          o.id,
          o.document,
          o.state,
          o.actionId,
          o.revision,
          o.updatedAt,
        ],
      );
    },
    async live(limit) {
      return (
        await rows(
          `SELECT * FROM messaging_outbound WHERE tenant_id=$1
          AND state IN ('approval_required','approved','sending','uncertain') ORDER BY updated_at,id LIMIT $2`,
          [tenantId, limit],
        )
      ).map(outbound);
    },
    async supplierChecks(limit) {
      return (
        await rows(
          `SELECT * FROM messaging_outbound WHERE tenant_id=$1 AND document ? 'procurement'
        AND state IN ('sent','failed') AND (document->>'ownerHandoffAt' IS NULL OR (state='sent' AND created_at > now()-interval '60 days' AND COALESCE(document->>'deliveryCheckedAt',created_at::text)::timestamptz < now()-interval '10 minutes'))
        ORDER BY COALESCE(document->>'deliveryCheckedAt',created_at::text)::timestamptz,id LIMIT $2`,
          [tenantId, limit],
        )
      ).map(outbound);
    },
    async markMessageSent(messageId) {
      await tx.query(
        "UPDATE messaging_messages SET origin='luma' WHERE tenant_id=$1 AND id=$2",
        [tenantId, messageId],
      );
    },
  };
}
