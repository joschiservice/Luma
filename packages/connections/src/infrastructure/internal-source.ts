import { randomUUID } from 'node:crypto';

import type { TenantContext } from '@luma/identity';
import { requirePermission, requireTenant } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';

import type { InstalledConnection } from '../domain/installation.js';

/** Provisions the built-in record source once, in the caller's transaction. Never enables authority. */
export function createInternalOrderSource(db: TenantDatabase) {
  return async (context: TenantContext): Promise<InstalledConnection> => {
    requireTenant(context, context.tenantId);
    requirePermission(context, 'sales.manage');

    return db.transaction(context.tenantId, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `internal-orders:${context.tenantId}`,
      ]);
      const existing = await tx.query<{ document: InstalledConnection }>(
        "SELECT document FROM connector_installations WHERE tenant_id=$1 AND document->>'provider'='luma-erp'",
        [context.tenantId],
      );
      if (existing.rows[0]) return existing.rows[0].document;
      const now = new Date().toISOString();
      const connection: InstalledConnection = {
        id: randomUUID(),
        tenantId: context.tenantId,
        provider: 'luma-erp',
        label: 'Luma ERP',
        target: { kind: 'luma-erp' },
        permissions: ['orders.read'],
        granted: ['orders.read'],
        status: 'active',
        version: 1,
        credentialVersion: 0,
        createdAt: now,
        updatedAt: now,
        management: [],
      };
      await tx.query(
        'INSERT INTO connector_installations(tenant_id,id,version,document,secret) VALUES($1,$2,1,$3,NULL)',
        [context.tenantId, connection.id, connection],
      );
      await tx.query(
        'INSERT INTO connector_lifecycle_events(tenant_id,connection_id,version,event,actor_id,status,credential_version,before_value,after_value) VALUES($1,$2,1,$3,$4,$5,0,$6,$7)',
        [
          context.tenantId,
          connection.id,
          'installed',
          context.actor.id,
          'active',
          {},
          {},
        ],
      );

      return connection;
    });
  };
}
