import { randomUUID } from 'node:crypto';

import type { TenantContext } from '@luma/identity';
import { requireRole, requireTenant } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';
import { z } from 'zod';

import type {
  CommerceObservation,
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
  if (input.capability === 'fulfillment.read') {
    refs.push({
      ...source,
      ...input.observation.data.order,
      resource: 'order',
    });
    for (const line of input.observation.data.lines)
      refs.push({ ...source, ...line.orderLine, resource: 'order_line' });
  }

  return refs;
}
