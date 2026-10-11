import type { SqlTransaction } from '@luma/platform';

import type {
  DocumentReadingRepository,
  FactRow,
  StoredRepresentation,
} from '../application/documents-store.js';
import type { DocumentRow } from '../application/store.js';
import { byPosition } from '../domain/facts.js';

type Row = Record<string, unknown>;

const iso = (value: unknown) =>
  value instanceof Date ? value.toISOString() : (value as string);

const isoOrNull = (value: unknown) =>
  value === null || value === undefined ? null : iso(value);

const columns = `id,message_id,thread_id,provider_attachment_id,filename,mime_type,size,sha256,family_key,version,
  previous_id,duplicate_of,state,failure,attempts,retain_until,purged_at,created_at,updated_at`;

function document(row: Row): DocumentRow {
  return {
    id: row.id as string,
    messageId: row.message_id as string,
    threadId: row.thread_id as string,
    providerAttachmentId: row.provider_attachment_id as string,
    filename: row.filename as string,
    mimeType: row.mime_type as string,
    size: row.size as number,
    sha256: (row.sha256 as string | null) ?? null,
    familyKey: row.family_key as string,
    version: row.version as number,
    previousId: (row.previous_id as string | null) ?? null,
    duplicateOf: (row.duplicate_of as string | null) ?? null,
    state: row.state as DocumentRow['state'],
    failure: (row.failure as string | null) ?? null,
    attempts: row.attempts as number,
    retainUntil: iso(row.retain_until),
    purgedAt: isoOrNull(row.purged_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function fact(row: Row): FactRow {
  return {
    id: row.id as string,
    documentId: row.document_id as string,
    factKey: row.fact_key as string,
    document: row.document as FactRow['document'],
    status: row.status as FactRow['status'],
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

/**
 * Document reading and facts over one tenant transaction. Content is read and written only
 * here and never selected with document lists.
 */
export function documentReading(
  tx: SqlTransaction,
  tenantId: string,
): DocumentReadingRepository {
  const rows = async (sql: string, values: unknown[]) =>
    (await tx.query<Row>(sql, values)).rows;

  return {
    async get(id, lock = false) {
      const [row] = await rows(
        `SELECT ${columns} FROM messaging_documents WHERE tenant_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`,
        [tenantId, id],
      );

      return row ? document(row) : null;
    },
    async representation(id) {
      const [row] = await rows(
        'SELECT representation FROM messaging_documents WHERE tenant_id=$1 AND id=$2',
        [tenantId, id],
      );

      return (row?.representation as StoredRepresentation | null) ?? null;
    },
    async claim(principalId, at, limit) {
      // A claimed or failed read waits 5 minutes before its next attempt, doubling per attempt, at most an hour.
      return (
        await rows(
          `WITH due AS (
            SELECT d.id FROM messaging_documents d
            JOIN messaging_threads t ON t.tenant_id=d.tenant_id AND t.id=d.thread_id
            JOIN messaging_mailboxes m ON m.tenant_id=t.tenant_id AND m.connection_id=t.connection_id
            WHERE d.tenant_id=$1 AND m.principal_id=$2 AND NOT m.paused AND m.blocked IS NULL
             AND (d.state='pending' OR (d.state='reading' AND d.updated_at <= $3::timestamptz
              - make_interval(secs => LEAST(3600, 300 * power(2, GREATEST(d.attempts-1,0))))))
            ORDER BY d.updated_at,d.id LIMIT $4 FOR UPDATE OF d SKIP LOCKED
          )
          UPDATE messaging_documents x SET state='reading',attempts=x.attempts+1,updated_at=$3
          FROM due WHERE x.tenant_id=$1 AND x.id=due.id
          RETURNING ${columns
            .split(',')
            .map((c) => `x.${c.trim()}`)
            .join(',')}`,
          [tenantId, principalId, at, limit],
        )
      )
        .map(document)
        .sort(
          (a, b) =>
            a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
        );
    },
    async lockContent(sha256) {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `messaging:document:${tenantId}:${sha256}`,
      ]);
    },
    async original(sha256, excludeId) {
      const [row] = await rows(
        `SELECT ${columns} FROM messaging_documents WHERE tenant_id=$1 AND sha256=$2 AND id<>$3
          AND state IN ('ready','unreadable') ORDER BY created_at,id LIMIT 1`,
        [tenantId, sha256, excludeId],
      );

      return row ? document(row) : null;
    },
    async previousVersion(d) {
      const [row] = await rows(
        `SELECT ${columns} FROM messaging_documents WHERE tenant_id=$1 AND family_key=$2 AND id<>$3
          AND state='ready' AND (created_at,id)<($4::timestamptz,$3::uuid)
          ORDER BY version DESC,created_at DESC,id DESC LIMIT 1`,
        [tenantId, d.familyKey, d.id, d.createdAt],
      );

      return row ? document(row) : null;
    },
    async update(d, content) {
      await tx.query(
        `UPDATE messaging_documents SET sha256=$3,family_key=$4,version=$5,previous_id=$6,duplicate_of=$7,state=$8,
          failure=$9,attempts=$10,updated_at=$11${content ? ',content=$12,representation=$13' : ''}
        WHERE tenant_id=$1 AND id=$2`,
        [
          tenantId,
          d.id,
          d.sha256,
          d.familyKey,
          d.version,
          d.previousId,
          d.duplicateOf,
          d.state,
          d.failure,
          d.attempts,
          d.updatedAt,
          ...(content
            ? [
                content.bytes ? Buffer.from(content.bytes) : null,
                content.representation,
              ]
            : []),
        ],
      );
    },
    async facts(documentIds) {
      if (!documentIds.length) return [];

      return (
        await rows(
          'SELECT * FROM messaging_facts WHERE tenant_id=$1 AND document_id=ANY($2::uuid[])',
          [tenantId, documentIds],
        )
      )
        .map(fact)
        .sort(
          (a, b) =>
            byPosition(a.document, b.document) || a.id.localeCompare(b.id),
        );
    },
    async fact(id, lock = false) {
      const [row] = await rows(
        `SELECT * FROM messaging_facts WHERE tenant_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`,
        [tenantId, id],
      );

      return row ? fact(row) : null;
    },
    async insertFact(f) {
      const result = await tx.query(
        `INSERT INTO messaging_facts(tenant_id,id,document_id,fact_key,document,status,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (tenant_id,document_id,fact_key) DO NOTHING`,
        [
          tenantId,
          f.id,
          f.documentId,
          f.factKey,
          f.document,
          f.status,
          f.createdAt,
          f.updatedAt,
        ],
      );

      return (result.rowCount ?? 0) > 0;
    },
    async updateFact(f) {
      await tx.query(
        'UPDATE messaging_facts SET document=$3,status=$4,updated_at=$5 WHERE tenant_id=$1 AND id=$2',
        [tenantId, f.id, f.document, f.status, f.updatedAt],
      );
    },
  };
}
