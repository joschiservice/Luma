import { randomUUID } from 'node:crypto';

import type { TenantContext } from '@luma/identity';
import { requireRole, requireTenant } from '@luma/identity';
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
  canonicalExists: (
    context: TenantContext,
    kind: SourceIdentity['resource'],
    id: string,
  ) => Promise<boolean>,
): SourceRecords {
  return {
    async record(context, ingestKey, input) {
      requireRole(context, ['owner', 'admin']);
      z.string().min(1).max(1024).parse(ingestKey);
      const value = commerceSchema.parse(input);
      requireTenant(context, value.observation.source.tenantId);

      return db.transaction(context.tenantId, async (tx) => {
        const source = value.observation.source;
        const installed = await tx.query<{
          document: {
            status: string;
            provider?: string;
            target: { kind: string };
          };
        }>(
          'SELECT document FROM connector_installations WHERE tenant_id=$1 AND id=$2',
          [context.tenantId, source.connectionId],
        );
        const connection = installed.rows[0]?.document;
        if (
          !connection ||
          (connection.provider ?? connection.target.kind) !== source.provider ||
          !['active', 'degraded'].includes(connection.status)
        )
          throw new Error('Connection unavailable');
        await tx.query(
          `INSERT INTO connector_observations(id,tenant_id,connection_id,ingest_key,document) VALUES($1,$2,$3,$4,$5)
     ON CONFLICT(tenant_id,connection_id,ingest_key) DO NOTHING`,
          [
            value.observation.id,
            context.tenantId,
            source.connectionId,
            ingestKey,
            value,
          ],
        );
        const stored = (
          await tx.query<{ document: CommerceObservation; matches: boolean }>(
            `SELECT document,(document #- '{observation,id}')=($4::jsonb #- '{observation,id}') AS matches
      FROM connector_observations WHERE tenant_id=$1 AND connection_id=$2 AND ingest_key=$3`,
            [context.tenantId, source.connectionId, ingestKey, value],
          )
        ).rows[0]!;
        if (!stored.matches) throw new Error('Ingest key conflict');

        return stored.document;
      });
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
    async bind(context, input, canonicalId, observationId, method) {
      requireRole(context, ['owner', 'admin']);
      const source = sourceSchema.parse(input);
      requireTenant(context, source.tenantId);
      z.string().uuid().parse(canonicalId);
      z.string().uuid().parse(observationId);
      z.string().min(1).max(1024).parse(method);
      if (!(await canonicalExists(context, source.resource, canonicalId)))
        throw new Error('Canonical mapping target not found');
      await db.transaction(context.tenantId, async (tx) => {
        const evidence = (
          await tx.query<{ document: CommerceObservation }>(
            'SELECT document FROM connector_observations WHERE tenant_id=$1 AND connection_id=$2 AND id=$3',
            [context.tenantId, source.connectionId, observationId],
          )
        ).rows[0]?.document;
        if (
          !evidence ||
          evidence.observation.source.provider !== source.provider ||
          !evidenceIdentities(evidence).some(
            (s) =>
              s.resource === source.resource &&
              s.externalId === source.externalId &&
              s.scopeKey === source.scopeKey,
          )
        )
          throw new Error(
            'Mapping evidence does not identify this source object',
          );
        const values = [
          context.tenantId,
          source.connectionId,
          source.resource,
          source.scopeKey,
          source.externalId,
        ];
        await tx.query(
          `INSERT INTO connector_source_mappings(id,tenant_id,connection_id,resource,scope_key,external_id,canonical_id,observation_id,method,actor_id)
     VALUES($6,$1,$2,$3,$4,$5,$7,$8,$9,$10) ON CONFLICT(tenant_id,connection_id,resource,scope_key,external_id) DO NOTHING`,
          [
            ...values,
            randomUUID(),
            canonicalId,
            observationId,
            method,
            context.actor.id,
          ],
        );
        const existing = (
          await tx.query<{ canonical_id: string }>(
            'SELECT canonical_id FROM connector_source_mappings WHERE tenant_id=$1 AND connection_id=$2 AND resource=$3 AND scope_key=$4 AND external_id=$5',
            values,
          )
        ).rows[0];
        if (existing?.canonical_id !== canonicalId)
          throw new Error('Source already maps to another canonical entity');
      });
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
        }>(
          `SELECT m.connection_id,COALESCE(i.document->>'provider',i.document->'target'->>'kind') AS provider,
            m.scope_key,m.external_id,m.canonical_id,
            COALESCE(r.method,m.method) AS method,COALESCE(r.actor_id,m.actor_id) AS actor_id,
            m.created_at,r.created_at AS revised_at
          FROM connector_source_mappings m
          JOIN connector_installations i ON i.tenant_id=m.tenant_id AND i.id=m.connection_id
          LEFT JOIN LATERAL (SELECT method,actor_id,created_at FROM connector_mapping_revisions r
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
        }));
      });
    },
    async remap(context, input, from, to, method, reason) {
      requireRole(context, ['owner', 'admin']);
      const source = sourceSchema.parse(input);
      requireTenant(context, source.tenantId);
      z.string().uuid().parse(from);
      z.string().uuid().parse(to);
      z.string().min(1).max(1024).parse(method);
      z.string().min(1).max(2000).parse(reason);
      if (from === to) throw new Error('Source already maps to this entity');
      if (!(await canonicalExists(context, source.resource, to)))
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

  return refs;
}
