import { randomUUID } from 'node:crypto';

import type { TenantContext } from '@luma/identity';
import { requirePermission, requireTenant } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';
import { z } from 'zod';

import type {
  CommerceObservation,
  SourceMapping,
  SourceRecords,
} from '../application/source-records.js';
import type { SourceIdentity } from '../domain/capabilities.js';
import { commerceSchema, sourceSchema } from './source-validation.js';

/**
 * Creates tenant-scoped observation storage and canonical mappings. Reusing an ingest key
 * with different content is rejected.
 */
export function createSourceRecords(
  db: TenantDatabase,
  canonicalMissing: (
    context: TenantContext,
    kind: SourceIdentity['resource'],
    ids: string[],
  ) => Promise<string[]>,
): SourceRecords {
  const recordMany: SourceRecords['recordMany'] = async (context, items) => {
    requirePermission(context, 'sync.manage');
    const values = items.map((item) => {
      z.string().min(1).max(1024).parse(item.ingestKey);
      const value = commerceSchema.parse(item.input);
      requireTenant(context, value.observation.source.tenantId);

      return { ingestKey: item.ingestKey, value };
    });
    if (!values.length) return [];

    return db.transaction(context.tenantId, async (tx) => {
      const installed = await tx.query<{
        id: string;
        document: {
          status: string;
          provider?: string;
          target: { kind: string };
        };
      }>(
        'SELECT id,document FROM connector_installations WHERE tenant_id=$1 AND id=ANY($2::uuid[])',
        [
          context.tenantId,
          [
            ...new Set(
              values.map(({ value }) => value.observation.source.connectionId),
            ),
          ],
        ],
      );
      const connections = new Map(
        installed.rows.map((row) => [row.id, row.document]),
      );
      for (const { value } of values) {
        const source = value.observation.source;
        const connection = connections.get(source.connectionId);
        if (
          !connection ||
          (connection.provider ?? connection.target.kind) !== source.provider ||
          !['active', 'degraded'].includes(connection.status)
        )
          throw new Error('Connection unavailable');
      }
      const rows = values.map(({ ingestKey, value }) => ({
        id: value.observation.id,
        connection_id: value.observation.source.connectionId,
        ingest_key: ingestKey,
        document: value,
      }));
      const key = (connectionId: string, ingestKey: string) =>
        JSON.stringify([connectionId, ingestKey]);
      const stored = new Map(
        (
          await tx.query<{
            connection_id: string;
            ingest_key: string;
            document: CommerceObservation;
          }>(
            `INSERT INTO connector_observations(id,tenant_id,connection_id,ingest_key,document)
            SELECT r.id,$1,r.connection_id,r.ingest_key,r.document
            FROM jsonb_to_recordset($2::jsonb) AS r(id uuid,connection_id uuid,ingest_key text,document jsonb)
            ON CONFLICT(tenant_id,connection_id,ingest_key) DO NOTHING
            RETURNING connection_id,ingest_key,document`,
            [context.tenantId, JSON.stringify(rows)],
          )
        ).rows.map((row) => [
          key(row.connection_id, row.ingest_key),
          row.document,
        ]),
      );
      // Keys stored earlier must hold the same observation apart from its ID.
      const existing = rows.filter(
        (row) => !stored.has(key(row.connection_id, row.ingest_key)),
      );
      if (existing.length) {
        const found = await tx.query<{
          connection_id: string;
          ingest_key: string;
          document: CommerceObservation;
          matches: boolean;
        }>(
          `SELECT o.connection_id,o.ingest_key,o.document,
            (o.document #- '{observation,id}')=(r.document #- '{observation,id}') AS matches
          FROM jsonb_to_recordset($2::jsonb) AS r(connection_id uuid,ingest_key text,document jsonb)
          JOIN connector_observations o ON o.tenant_id=$1 AND o.connection_id=r.connection_id AND o.ingest_key=r.ingest_key`,
          [context.tenantId, JSON.stringify(existing)],
        );
        for (const row of found.rows) {
          if (!row.matches) throw new Error('Ingest key conflict');
          stored.set(key(row.connection_id, row.ingest_key), row.document);
        }
      }

      return rows.map((row) => {
        const document = stored.get(key(row.connection_id, row.ingest_key));
        if (!document) throw new Error('Ingest key conflict');

        return document;
      });
    });
  };

  const bindMany: SourceRecords['bindMany'] = async (context, entries) => {
    requirePermission(context, 'sync.manage');
    const values = entries.map((entry) => {
      const source = sourceSchema.parse(entry.source);
      requireTenant(context, source.tenantId);
      z.string().uuid().parse(entry.canonicalId);
      z.string().uuid().parse(entry.observationId);
      z.string().min(1).max(1024).parse(entry.method);

      return { ...entry, source };
    });
    if (!values.length) return;
    for (const resource of new Set(
      values.map((value) => value.source.resource),
    ))
      if (
        (
          await canonicalMissing(
            context,
            resource,
            values
              .filter((value) => value.source.resource === resource)
              .map((value) => value.canonicalId),
          )
        ).length
      )
        throw new Error('Canonical mapping target not found');
    await db.transaction(context.tenantId, async (tx) => {
      const evidence = new Map(
        (
          await tx.query<{
            id: string;
            connection_id: string;
            document: CommerceObservation;
          }>(
            'SELECT id,connection_id,document FROM connector_observations WHERE tenant_id=$1 AND id=ANY($2::uuid[])',
            [
              context.tenantId,
              [...new Set(values.map((value) => value.observationId))],
            ],
          )
        ).rows.map((row) => [row.id, row]),
      );
      for (const { source, observationId } of values) {
        const stored = evidence.get(observationId);
        if (
          !stored ||
          stored.connection_id !== source.connectionId ||
          stored.document.observation.source.provider !== source.provider ||
          !evidenceIdentities(stored.document).some(
            (s) =>
              s.resource === source.resource &&
              s.externalId === source.externalId &&
              s.scopeKey === source.scopeKey,
          )
        )
          throw new Error(
            'Mapping evidence does not identify this source object',
          );
      }
      const rows = JSON.stringify(
        values.map((value) => ({
          connection_id: value.source.connectionId,
          resource: value.source.resource,
          scope_key: value.source.scopeKey,
          external_id: value.source.externalId,
          canonical_id: value.canonicalId,
          observation_id: value.observationId,
          method: value.method,
        })),
      );
      // Sorted inserts keep concurrent imports of overlapping records from deadlocking.
      await tx.query(
        `INSERT INTO connector_source_mappings(id,tenant_id,connection_id,resource,scope_key,external_id,canonical_id,observation_id,method,actor_id)
        SELECT gen_random_uuid(),$1,r.connection_id,r.resource,r.scope_key,r.external_id,r.canonical_id,r.observation_id,r.method,$3
        FROM jsonb_to_recordset($2::jsonb) AS r(connection_id uuid,resource text,scope_key text,external_id text,
          canonical_id uuid,observation_id uuid,method text)
        ORDER BY r.connection_id,r.resource,r.scope_key,r.external_id
        ON CONFLICT(tenant_id,connection_id,resource,scope_key,external_id) DO NOTHING`,
        [context.tenantId, rows, context.actor.id],
      );
      const conflicting = await tx.query(
        `SELECT 1 FROM jsonb_to_recordset($2::jsonb) AS r(connection_id uuid,resource text,scope_key text,external_id text,canonical_id uuid)
        LEFT JOIN connector_source_mappings m ON m.tenant_id=$1 AND m.connection_id=r.connection_id AND m.resource=r.resource
          AND m.scope_key=r.scope_key AND m.external_id=r.external_id
        WHERE m.canonical_id IS DISTINCT FROM r.canonical_id LIMIT 1`,
        [context.tenantId, rows],
      );
      if (conflicting.rowCount)
        throw new Error('Source already maps to another canonical entity');
    });
  };

  return {
    recordMany,
    bindMany,
    async record(context, ingestKey, input) {
      return (await recordMany(context, [{ ingestKey, input }]))[0]!;
    },
    async get(context, connectionId, ingestKey) {
      requireTenant(context, context.tenantId);

      return db.transaction(
        context.tenantId,
        async (tx) =>
          (
            await tx.query<{ document: CommerceObservation }>(
              'SELECT document FROM connector_observations WHERE tenant_id=$1 AND connection_id=$2 AND ingest_key=$3',
              [context.tenantId, connectionId, ingestKey],
            )
          ).rows[0]?.document ?? null,
      );
    },
    async bind(context, source, canonicalId, observationId, method) {
      await bindMany(context, [{ source, canonicalId, observationId, method }]);
    },
    async resolve(context, input) {
      const source = sourceSchema.parse(input);
      requireTenant(context, source.tenantId);

      return db.transaction(
        context.tenantId,
        async (tx) =>
          (
            await tx.query<{ canonical_id: string }>(
              'SELECT canonical_id FROM connector_source_mappings WHERE tenant_id=$1 AND connection_id=$2 AND resource=$3 AND scope_key=$4 AND external_id=$5',
              [
                context.tenantId,
                source.connectionId,
                source.resource,
                source.scopeKey,
                source.externalId,
              ],
            )
          ).rows[0]?.canonical_id ?? null,
      );
    },
    async resolveMany(context, input) {
      requireTenant(context, context.tenantId);
      const list = z.array(sourceSchema).max(10000).parse(input);
      const found = new Map<string, string>();
      if (!list.length) return found;
      if (list.some((source) => source.tenantId !== context.tenantId))
        throw new Error('Source belongs to another workspace');
      const result = await db.transaction(context.tenantId, (tx) =>
        tx.query<{
          connection_id: string;
          resource: string;
          scope_key: string;
          external_id: string;
          canonical_id: string;
        }>(
          `SELECT m.connection_id,m.resource,m.scope_key,m.external_id,m.canonical_id
          FROM unnest($2::uuid[],$3::text[],$4::text[],$5::text[]) AS k(connection_id,resource,scope_key,external_id)
          JOIN connector_source_mappings m ON m.tenant_id=$1 AND m.connection_id=k.connection_id
            AND m.resource=k.resource AND m.scope_key=k.scope_key AND m.external_id=k.external_id`,
          [
            context.tenantId,
            list.map((source) => source.connectionId),
            list.map((source) => source.resource),
            list.map((source) => source.scopeKey),
            list.map((source) => source.externalId),
          ],
        ),
      );
      for (const row of result.rows)
        found.set(
          JSON.stringify([
            row.connection_id,
            row.resource,
            row.scope_key,
            row.external_id,
          ]),
          row.canonical_id,
        );

      return found;
    },
    async observation(context, connectionId, observationId) {
      requireTenant(context, context.tenantId);
      z.string().uuid().parse(connectionId);
      z.string().uuid().parse(observationId);

      return db.transaction(
        context.tenantId,
        async (tx) =>
          (
            await tx.query<{ document: CommerceObservation }>(
              'SELECT document FROM connector_observations WHERE tenant_id=$1 AND connection_id=$2 AND id=$3',
              [context.tenantId, connectionId, observationId],
            )
          ).rows[0]?.document ?? null,
      );
    },
    async revised(context, resource, canonicalIds) {
      requireTenant(context, context.tenantId);
      const ids = [...new Set(canonicalIds)];
      if (!ids.length) return new Set<string>();

      return db.transaction(
        context.tenantId,
        async (tx) =>
          new Set(
            (
              await tx.query<{ canonical_id: string }>(
                `SELECT DISTINCT m.canonical_id FROM connector_source_mappings m
                WHERE m.tenant_id=$1 AND m.resource=$2 AND m.canonical_id=ANY($3::uuid[])
                  AND EXISTS (SELECT 1 FROM connector_mapping_revisions r WHERE r.tenant_id=m.tenant_id AND r.mapping_id=m.id)`,
                [context.tenantId, resource, ids],
              )
            ).rows.map((row) => row.canonical_id),
          ),
      );
    },
    async mappings(context, resource, canonicalId) {
      requireTenant(context, context.tenantId);
      z.string().uuid().parse(canonicalId);

      return db.transaction(context.tenantId, async (tx) => {
        const result = await tx.query<{
          connection_id: string;
          provider: string;
          scope_key: string;
          external_id: string;
          canonical_id: string;
          method: string;
          actor_id: string;
          created_at: Date;
          revised_at: Date | null;
          revision_id: string | null;
          from_canonical_id: string | null;
        }>(
          `SELECT m.connection_id,COALESCE(i.document->>'provider',i.document->'target'->>'kind') AS provider,
            m.scope_key,m.external_id,m.canonical_id,
            COALESCE(r.method,m.method) AS method,COALESCE(r.actor_id,m.actor_id) AS actor_id,
            m.created_at,r.created_at AS revised_at,r.id AS revision_id,r.from_canonical_id
          FROM connector_source_mappings m
          JOIN connector_installations i ON i.tenant_id=m.tenant_id AND i.id=m.connection_id
          LEFT JOIN LATERAL (SELECT id,method,actor_id,created_at,from_canonical_id FROM connector_mapping_revisions r
            WHERE r.tenant_id=m.tenant_id AND r.mapping_id=m.id ORDER BY r.created_at DESC,r.id DESC LIMIT 1) r ON true
          WHERE m.tenant_id=$1 AND m.resource=$2 AND m.canonical_id=$3
          ORDER BY m.connection_id,m.scope_key,m.external_id`,
          [context.tenantId, resource, canonicalId],
        );

        return result.rows.map((row): SourceMapping => ({
          source: {
            tenantId: context.tenantId,
            connectionId: row.connection_id,
            provider: row.provider,
            resource,
            scopeKey: row.scope_key,
            externalId: row.external_id,
          },
          canonicalId: row.canonical_id,
          method: row.method,
          actorId: row.actor_id,
          createdAt: row.created_at.toISOString(),
          revisedAt: row.revised_at?.toISOString() ?? null,
          revisionId: row.revision_id,
          previousCanonicalId: row.from_canonical_id,
        }));
      });
    },
    async remap(context, input, from, to, method, reason) {
      requirePermission(context, 'sync.manage');
      const source = sourceSchema.parse(input);
      requireTenant(context, source.tenantId);
      z.string().uuid().parse(from);
      z.string().uuid().parse(to);
      z.string().min(1).max(1024).parse(method);
      z.string().min(1).max(2000).parse(reason);
      if (from === to) throw new Error('Source already maps to this entity');
      if ((await canonicalMissing(context, source.resource, [to])).length)
        throw new Error('Canonical mapping target not found');

      return db.transaction(context.tenantId, async (tx) => {
        const mapping = (
          await tx.query<{ id: string }>(
            `SELECT id FROM connector_source_mappings WHERE tenant_id=$1 AND connection_id=$2 AND resource=$3
            AND scope_key=$4 AND external_id=$5 AND canonical_id=$6 FOR UPDATE`,
            [
              context.tenantId,
              source.connectionId,
              source.resource,
              source.scopeKey,
              source.externalId,
              from,
            ],
          )
        ).rows[0];
        if (!mapping) return false;
        // The revision is written first; a trigger rejects mapping changes without one.
        await tx.query(
          `INSERT INTO connector_mapping_revisions(id,tenant_id,mapping_id,connection_id,resource,from_canonical_id,to_canonical_id,method,reason,actor_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            randomUUID(),
            context.tenantId,
            mapping.id,
            source.connectionId,
            source.resource,
            from,
            to,
            method,
            reason,
            context.actor.id,
          ],
        );
        await tx.query(
          'UPDATE connector_source_mappings SET canonical_id=$3 WHERE tenant_id=$1 AND id=$2',
          [context.tenantId, mapping.id, to],
        );

        return true;
      });
    },
  };
}

function evidenceIdentities(input: CommerceObservation) {
  const source = input.observation.source;
  const refs = [source];
  if (
    input.capability === 'inventory.transfers.read' ||
    input.capability === 'inventory.shipments.read'
  ) {
    for (const line of input.observation.data.lines ?? [])
      if (line.sku) refs.push({ ...source, ...line.sku, resource: 'sku' });
    if (input.capability === 'inventory.transfers.read') {
      for (const location of [
        input.observation.data.origin,
        input.observation.data.destination,
      ])
        if (location?.id)
          refs.push({ ...source, ...location.id, resource: 'location' });
      for (const shipment of input.observation.data.shipments ?? [])
        refs.push({ ...source, ...shipment, resource: 'inventory_shipment' });
    }
  }
  if (input.capability === 'orders.read')
    for (const line of input.observation.data.lines) {
      refs.push({ ...source, ...line.id, resource: 'order_line' });
      if (line.sku) refs.push({ ...source, ...line.sku, resource: 'sku' });
    }
  if (input.capability === 'inventory.read') {
    refs.push({ ...source, ...input.observation.data.sku, resource: 'sku' });
    refs.push({
      ...source,
      ...input.observation.data.location,
      resource: 'location',
    });
  }
  if (input.capability === 'products.read')
    for (const sku of input.observation.data.skus)
      refs.push({ ...source, ...sku.id, resource: 'sku' });
  if (input.capability === 'fulfillment.read') {
    refs.push({
      ...source,
      ...input.observation.data.order,
      resource: 'order',
    });
    for (const line of input.observation.data.lines)
      refs.push({ ...source, ...line.orderLine, resource: 'order_line' });
    const location = input.observation.data.location;
    if (location)
      refs.push({ ...source, ...location.id, resource: 'location' });
  }
  if (input.capability === 'returns.read') {
    const data = input.observation.data;
    refs.push({ ...source, ...data.order, resource: 'order' });
    for (const line of data.lines)
      if (line.orderLine)
        refs.push({ ...source, ...line.orderLine, resource: 'order_line' });
    if (data.type === 'refund' && data.return)
      refs.push({ ...source, ...data.return, resource: 'return' });
  }

  return refs;
}
