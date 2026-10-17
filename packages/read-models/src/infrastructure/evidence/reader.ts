import type { Permission, TenantContext } from '@luma/identity';
import { hasPermission, requireTenant } from '@luma/identity';
import type { SqlTransaction, TenantDatabase } from '@luma/platform';
import { forbidden, invalid, notFound, unavailable } from '@luma/platform';

import type {
  EvidenceOwners,
  EvidenceReader,
} from '../../application/evidence.js';
import {
  type Citation,
  type EvidencePerson,
  evidenceReferenceLimit,
  notRetainedEvidence,
  resolveEvidence,
  type RetentionKind,
} from '../../domain/evidence.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Keeps references that can name a row: stored evidence and records have UUID IDs. */
function uuidRefs(refs: Iterable<string>) {
  return [...new Set(refs)].filter((ref) => uuid.test(ref));
}

/**
 * The receipts and verification reads the execution attempts of `actionIds` cite. A receipt is
 * cited when the attempt finished; a verification read when its check observed.
 */
async function attemptCitations(
  tx: SqlTransaction,
  tenantId: string,
  actionIds: string[],
): Promise<Citation[]> {
  const ids = uuidRefs(actionIds);
  if (!ids.length) return [];
  const { rows } = await tx.query<{
    receipts: unknown;
    capability: string | null;
    cited_at: string | null;
    observation_refs: unknown;
    observed_at: string | null;
  }>(
    `SELECT document->'attempt'->'effectEvidenceRefs' AS receipts,
      document->'intent'->>'capability' AS capability,
      COALESCE(document->'attempt'->>'finishedAt',document->'attempt'->>'startedAt') AS cited_at,
      document->'attempt'->'verification'->'observationRefs' AS observation_refs,
      document->'attempt'->'verification'->>'observedAt' AS observed_at
     FROM executed_actions WHERE tenant_id=$1 AND proposal_id=ANY($2::uuid[]) LIMIT 200`,
    [tenantId, ids],
  );
  const strings = (value: unknown) =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : [];

  return rows.flatMap((row) => [
    ...strings(row.receipts).map((ref) => ({
      ref,
      citedAs: 'write_receipt' as const,
      citedAt: row.cited_at,
      capability: row.capability,
    })),
    ...strings(row.observation_refs).map((ref) => ({
      ref,
      citedAs: 'read' as const,
      citedAt: row.observed_at,
    })),
  ]);
}

/**
 * Creates the cross-owner evidence reader. Each subject kind is resolved by its owner in one
 * read-only snapshot: the owner reports what the subject cites and finds the stored evidence;
 * execution attempts, connection names and retention starts are read here. Lookups are batched
 * per table, and one request resolves at most 100 references.
 */
export function createEvidenceReader(
  db: TenantDatabase,
  owners: EvidenceOwners,
  now: () => Date = () => new Date(),
): EvidenceReader {
  return {
    async resolve(context: TenantContext, request) {
      requireTenant(context, context.tenantId);
      const { subject } = request;
      const owner = owners[subject.kind];
      if (!owner) throw unavailable('This evidence is unavailable');
      if (owner.permission && !hasPermission(context, owner.permission))
        throw forbidden('You do not have access to this evidence');
      if (request.refs && request.refs.length > evidenceReferenceLimit)
        throw invalid(
          `Resolve at most ${evidenceReferenceLimit} references at once`,
        );

      return db.transaction(
        context.tenantId,
        async (tx) => {
          const tenantId = context.tenantId;
          const access = {
            can: (permission: Permission) => hasPermission(context, permission),
          };
          const own = await owner.citations(tx, tenantId, subject.id, access);
          if (!own) throw notFound('This record was not found');
          const citations = [
            ...own.citations,
            ...(await attemptCitations(tx, tenantId, own.actionIds)),
          ];
          const all = [...new Set(citations.map((c) => c.ref))];
          const refs = request.refs
            ? [...new Set(request.refs)]
            : all.slice(0, evidenceReferenceLimit);
          const uuids = uuidRefs(refs);
          const requested = new Set(uuids);
          const found = await owner.lookup(
            tx,
            tenantId,
            subject.id,
            {
              all: refs,
              uuids,
              cited: uuidRefs(
                citations
                  .filter((c) => c.citedAs !== 'record')
                  .map((c) => c.ref),
              ).filter((ref) => requested.has(ref)),
            },
            access,
          );
          const connectionIds = uuidRefs(
            found.flatMap((e) =>
              e.kind === 'luma_record' || e.kind === 'restricted'
                ? []
                : [e.connectionId],
            ),
          );
          const labels = new Map<string, string | null>(
            connectionIds.length
              ? (
                  await tx.query<{ id: string; label: string | null }>(
                    `SELECT id::text,document->>'label' AS label FROM connector_installations
                     WHERE tenant_id=$1 AND id=ANY($2::uuid[])`,
                    [tenantId, connectionIds],
                  )
                ).rows.map((row) => [row.id, row.label])
              : [],
          );
          const actorIds = uuidRefs(
            found.flatMap((e) =>
              e.kind === 'luma_record' && e.actorId ? [e.actorId] : [],
            ),
          );
          const people = new Map<string, EvidencePerson>(
            actorIds.length
              ? (
                  await tx.query<EvidencePerson>(
                    `SELECT user_id::text AS id,name,email,is_member AS member FROM workspace_people
                     WHERE tenant_id=$1 AND user_id=ANY($2::uuid[])`,
                    [tenantId, actorIds],
                  )
                ).rows.map((person) => [person.id.toLowerCase(), person])
              : [],
          );
          const starts = new Map(
            (
              await tx.query<{ kind: RetentionKind; started_at: Date }>(
                'SELECT kind,started_at FROM evidence_retention_starts',
              )
            ).rows.map((row) => [row.kind, row.started_at.toISOString()]),
          );

          return {
            subject,
            items: resolveEvidence({
              refs,
              citations,
              found,
              labels,
              people,
              start: (citedAs) => {
                const kind =
                  citedAs === 'record' ? null : owner.retention[citedAs];

                return kind ? (starts.get(kind) ?? null) : null;
              },
            }),
            notRetained: request.refs
              ? []
              : notRetainedEvidence(
                  own.uncited ?? [],
                  (kind) => starts.get(kind) ?? null,
                ),
            truncated: !request.refs && all.length > refs.length,
            asOf: now().toISOString(),
          };
        },
        { readOnlySnapshot: true },
      );
    },
  };
}
