import type { SqlTransaction } from '@luma/platform';

import type { ReturnWriteReceipt } from '../application/return-write-receipts.js';
import type { ReturnReadEvidence } from '../domain/return-reads.js';

/**
 * The return records whose cited evidence can be read: the creation, settlement and exchange
 * writes, an exchange with its availability and completion checks, and a deadline wait.
 */
export type ReturnEvidenceKind =
  'creation' | 'settlement' | 'exchange_step' | 'exchange' | 'wait';

/** A reference a return record cites, and when the citing record was written. */
interface ReturnCitation {
  ref: string;
  citedAs: 'read' | 'write_receipt' | 'record';
  citedAt: string | null;
}

/** Stored evidence or a return record that a reference names. */
type ReturnEvidence =
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
      adapterVersion: string | null;
    }
  | {
      kind: 'luma_record';
      id: string;
      record:
        | 'return_case'
        | 'return_creation'
        | 'return_settlement'
        | 'return_exchange'
        | 'return_exchange_step';
    };

const tables = {
  creation: 'orders_return_creations',
  settlement: 'orders_return_actions',
  exchange_step: 'orders_return_exchange_steps',
  exchange: 'orders_return_exchanges',
  wait: 'orders_return_waits',
} as const satisfies Record<ReturnEvidenceKind, string>;

/** Money evidence names the case revision it was read for, as `case:<id>:<revision>`. */
const caseRevisionRef = /^case:([0-9a-f-]{36}):\d+$/i;

/** A part of a return record that cites reads, with when they were observed or checked. */
type CitingPart = {
  observedAt?: unknown;
  checkedAt?: unknown;
  evidenceRefs?: unknown;
} | null;

/**
 * Reads what one return record cites, for the evidence view. A write cites its execution action
 * and the reads its proof and quote name; an exchange the reads behind its availability and its
 * completion check; a wait the reads or case revision its last observation found. Reads are
 * cited when they were observed. Returns null when the tenant has no such record.
 */
export async function returnCitations(
  tx: SqlTransaction,
  tenantId: string,
  kind: ReturnEvidenceKind,
  id: string,
): Promise<{ actionIds: string[]; citations: ReturnCitation[] } | null> {
  const { rows } = await tx.query<{
    document: {
      actionId?: unknown;
      proof?: CitingPart;
      quote?: CitingPart;
      availability?: CitingPart;
      completion?: CitingPart;
      observedAt?: unknown;
      evidenceRefs?: unknown;
    };
  }>(`SELECT document FROM ${tables[kind]} WHERE tenant_id=$1 AND id=$2`, [
    tenantId,
    id,
  ]);
  const record = rows[0]?.document;
  if (!record) return null;
  const reads = (part: CitingPart | undefined): ReturnCitation[] => {
    if (!part || !Array.isArray(part.evidenceRefs)) return [];
    const at = part.observedAt ?? part.checkedAt;

    return part.evidenceRefs
      .filter((ref): ref is string => typeof ref === 'string')
      .map((ref) => ({
        ref,
        citedAs: caseRevisionRef.test(ref) ? 'record' : 'read',
        citedAt: typeof at === 'string' ? at : null,
      }));
  };
  const parts =
    kind === 'exchange'
      ? [record.availability, record.completion]
      : kind === 'wait'
        ? [record]
        : [record.proof, record.quote];

  return {
    actionIds:
      kind !== 'exchange' &&
      kind !== 'wait' &&
      typeof record.actionId === 'string'
        ? [record.actionId]
        : [],
    citations: parts.flatMap(reads),
  };
}

/**
 * Finds the provider reads and write receipts orders stored for the record's return case, and
 * the case's records that the references name. Every query is scoped to that case, so a
 * reference from another case resolves to nothing.
 */
export async function returnEvidence(
  tx: SqlTransaction,
  tenantId: string,
  kind: ReturnEvidenceKind,
  id: string,
  refs: { all: string[]; uuids: string[] },
): Promise<ReturnEvidence[]> {
  const caseRefs = refs.all.flatMap((ref) => {
    const match = caseRevisionRef.exec(ref);

    return match?.[1] ? [{ ref, caseId: match[1].toLowerCase() }] : [];
  });
  if (!refs.uuids.length && !caseRefs.length) return [];
  const owner = (
    await tx.query<{ case_id: string }>(
      `SELECT case_id::text FROM ${tables[kind]} WHERE tenant_id=$1 AND id=$2`,
      [tenantId, id],
    )
  ).rows[0];
  if (!owner) return [];
  const stored = await tx.query<
    | { kind: 'read'; document: ReturnReadEvidence }
    | { kind: 'write_receipt'; document: ReturnWriteReceipt }
  >(
    `SELECT kind,document FROM orders_return_read_evidence
     WHERE tenant_id=$1 AND case_id=$2 AND id=ANY($3::uuid[])`,
    [tenantId, owner.case_id, refs.uuids],
  );
  const records = await tx.query<{
    id: string;
    record: Extract<ReturnEvidence, { kind: 'luma_record' }>['record'];
  }>(
    `SELECT id::text,'return_case' AS record FROM orders_return_cases
      WHERE tenant_id=$1 AND id=$2 AND id=ANY($3::uuid[])
     UNION ALL SELECT id::text,'return_creation' FROM orders_return_creations
      WHERE tenant_id=$1 AND case_id=$2 AND id=ANY($3::uuid[])
     UNION ALL SELECT id::text,'return_settlement' FROM orders_return_actions
      WHERE tenant_id=$1 AND case_id=$2 AND id=ANY($3::uuid[])
     UNION ALL SELECT id::text,'return_exchange' FROM orders_return_exchanges
      WHERE tenant_id=$1 AND case_id=$2 AND id=ANY($3::uuid[])
     UNION ALL SELECT id::text,'return_exchange_step' FROM orders_return_exchange_steps
      WHERE tenant_id=$1 AND case_id=$2 AND id=ANY($3::uuid[])`,
    [tenantId, owner.case_id, refs.uuids],
  );

  return [
    ...stored.rows.map((row): ReturnEvidence => {
      if (row.kind === 'write_receipt') {
        const receipt = row.document;

        return {
          kind: 'write_receipt',
          id: receipt.id,
          provider: receipt.source.provider,
          connectionId: receipt.source.connectionId,
          capability: receipt.capability,
          acceptedAt: receipt.observedAt,
          records: receipt.records,
          providerRequestId: receipt.providerRequestId,
          adapterVersion: receipt.adapterVersion ?? null,
        };
      }
      const read = row.document;

      return {
        kind: 'read',
        id: read.id,
        provider: read.source.provider,
        connectionId: read.source.connectionId,
        record: {
          resource: read.source.resource,
          externalId: read.source.externalId,
        },
        observedAt: read.observedAt,
        sourceUpdatedAt: read.sourceUpdatedAt,
        sourceRevision: read.sourceRevision,
        adapterVersion: read.adapterVersion,
        completeness: read.completeness,
        data: read.data,
      };
    }),
    ...records.rows.map((row) => ({
      kind: 'luma_record' as const,
      id: row.id,
      record: row.record,
    })),
    // Money evidence names the case revision it read; only this write's case resolves.
    ...caseRefs
      .filter((ref) => ref.caseId === owner.case_id)
      .map((ref) => ({
        kind: 'luma_record' as const,
        id: ref.ref,
        record: 'return_case' as const,
      })),
  ];
}
