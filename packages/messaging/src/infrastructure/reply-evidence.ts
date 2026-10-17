import type { SqlTransaction } from '@luma/platform';

import type { SendReceipt } from '../domain/send-receipts.js';

/**
 * Stored evidence or a messaging record that a reply's reference names, in the shape the
 * evidence view reads. Messages are reads of the mailbox; their addresses, subject and text
 * never leave messaging.
 */
type ReplyEvidence =
  | {
      kind: 'read';
      id: string;
      provider: string;
      connectionId: string;
      record: { resource: string; externalId: string } | null;
      observedAt: string;
      sourceUpdatedAt: string | null;
      sourceRevision: string | null;
      adapterVersion: string | null;
      completeness: 'complete' | 'partial' | null;
      data: unknown;
    }
  | {
      kind: 'write_receipt';
      id: string;
      provider: string;
      connectionId: string;
      capability: string;
      acceptedAt: string;
      records: { resource: string; externalId: string }[];
      providerRequestId: string | null;
    }
  | { kind: 'luma_record'; id: string; record: 'reply' | 'thread' };

/**
 * Reads what a reply cites, for the evidence view: the send action whose execution attempt
 * cites the send receipt and the verifying thread read. Returns null when the tenant has no such
 * reply.
 */
export async function replyCitations(
  tx: SqlTransaction,
  tenantId: string,
  outboundId: string,
): Promise<{ actionIds: string[]; citations: [] } | null> {
  const { rows } = await tx.query<{ action_id: string | null }>(
    'SELECT action_id::text FROM messaging_outbound WHERE tenant_id=$1 AND id=$2',
    [tenantId, outboundId],
  );
  const reply = rows[0];
  if (!reply) return null;

  return {
    actionIds: reply.action_id ? [reply.action_id] : [],
    citations: [],
  };
}

/**
 * Finds the reply's stored send receipts, the messages of its thread and the reply and thread
 * records that the references name. Message reads carry the provider's message ID and times,
 * never addresses, subject or text. Every query is scoped to the reply and its thread.
 */
export async function replyEvidence(
  tx: SqlTransaction,
  tenantId: string,
  outboundId: string,
  refs: { uuids: string[] },
): Promise<ReplyEvidence[]> {
  if (!refs.uuids.length) return [];
  const receipts = await tx.query<{ document: SendReceipt }>(
    `SELECT document FROM messaging_send_receipts
     WHERE tenant_id=$1 AND outbound_id=$2 AND id=ANY($3::uuid[])`,
    [tenantId, outboundId, refs.uuids],
  );
  const messages = await tx.query<{
    id: string;
    connection_id: string;
    provider: string;
    provider_message_id: string;
    created_at: Date;
    received_at: Date;
  }>(
    `SELECT m.id::text,m.connection_id::text,b.document->>'provider' AS provider,
      m.provider_message_id,m.created_at,m.received_at
     FROM messaging_outbound o
     JOIN messaging_messages m ON m.tenant_id=o.tenant_id AND m.thread_id=o.thread_id
     JOIN messaging_mailboxes b ON b.tenant_id=m.tenant_id AND b.connection_id=m.connection_id
     WHERE o.tenant_id=$1 AND o.id=$2 AND m.id=ANY($3::uuid[])`,
    [tenantId, outboundId, refs.uuids],
  );
  const records = await tx.query<{ id: string; record: 'reply' | 'thread' }>(
    `SELECT id::text,'reply' AS record FROM messaging_outbound
      WHERE tenant_id=$1 AND id=$2 AND id=ANY($3::uuid[])
     UNION ALL SELECT thread_id::text,'thread' FROM messaging_outbound
      WHERE tenant_id=$1 AND id=$2 AND thread_id=ANY($3::uuid[])`,
    [tenantId, outboundId, refs.uuids],
  );

  return [
    ...receipts.rows.map(({ document }): ReplyEvidence => ({
      kind: 'write_receipt',
      id: document.id,
      provider: document.source.provider,
      connectionId: document.source.connectionId,
      capability: document.capability,
      acceptedAt: document.observedAt,
      records: document.records,
      providerRequestId: document.providerRequestId,
    })),
    ...messages.rows.map((row): ReplyEvidence => ({
      kind: 'read',
      id: row.id,
      provider: row.provider,
      connectionId: row.connection_id,
      record: { resource: 'message', externalId: row.provider_message_id },
      // Messaging stores a message when a thread read finds it.
      observedAt: row.created_at.toISOString(),
      sourceUpdatedAt: row.received_at.toISOString(),
      sourceRevision: null,
      adapterVersion: null,
      completeness: null,
      data: null,
    })),
    ...records.rows.map((row) => ({
      kind: 'luma_record' as const,
      id: row.id,
      record: row.record,
    })),
  ];
}
