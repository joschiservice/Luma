import type { TenantContext } from '@luma/identity';
import { IdentityError } from '@luma/identity';
import type { SqlTransaction, TenantDatabase } from '@luma/platform';
import { z } from 'zod';

import type { PackageStore } from '../application/packages.js';
import type {
  OperationalPackage,
  PackageConfiguration,
  PackageInstallation,
  PackageReceipt,
  PackageResource,
} from '../domain/packages.js';

const configuration = z
  .object({
    parameters: z.record(
      z.string().min(1).max(100),
      z.union([z.string().max(2000), z.number().finite(), z.boolean()]),
    ),
    sharing: z
      .object({
        scope: z.enum(['workspace', 'roles']),
        roleIds: z.array(z.string().min(1).max(100)).max(50),
      })
      .strict(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if ((c.sharing.scope === 'roles') !== c.sharing.roleIds.length > 0)
      ctx.addIssue({
        code: 'custom',
        message: 'Choose roles only for role sharing.',
      });
  });
const installation = z.object({
  packageId: z.string(),
  version: z.string(),
  revision: z.number().int().positive(),
  config: configuration,
  resources: z.array(
    z.object({
      kind: z.enum(['field', 'view', 'workflow']),
      key: z.string(),
      id: z.string(),
    }),
  ),
  removed: z.boolean(),
});
const receipt = z.object({
  commandId: z.string().uuid(),
  digest: z.string(),
  result: installation.nullable(),
});

/** Validates a bounded parameter set at the persistence and command boundary. */
export function parsePackageConfiguration(
  input: unknown,
): PackageConfiguration {
  return configuration.parse(input);
}

/** Provides atomic package metadata and transaction-scoped owner operations. */
export function createPackageStore(
  db: TenantDatabase,
  owners: {
    install(
      db: TenantDatabase,
      context: TenantContext,
      definition: OperationalPackage,
      prior: PackageInstallation | null,
    ): Promise<PackageResource[]>;
    remove(
      db: TenantDatabase,
      context: TenantContext,
      installation: PackageInstallation,
    ): Promise<void>;
  },
): PackageStore {
  async function get(tx: SqlTransaction, tenantId: string, id: string) {
    const row = (
      await tx.query<{ document: unknown }>(
        'SELECT document FROM adaptive_package_installations WHERE tenant_id=$1 AND package_id=$2',
        [tenantId, id],
      )
    ).rows[0];

    return row ? installation.parse(row.document) : null;
  }

  return {
    get: (context, id) =>
      db.transaction(context.tenantId, (tx) => get(tx, context.tenantId, id)),
    transaction: (context, work) =>
      db.transaction(context.tenantId, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `adaptive-package:${context.tenantId}`,
        ]);
        const scoped: TenantDatabase = {
          transaction: async (tenantId, operation) => {
            if (tenantId !== context.tenantId)
              throw new IdentityError(404, 'NOT_FOUND', 'Resource not found.');

            return operation(tx);
          },
        };

        return work({
          installation: (id) => get(tx, context.tenantId, id),
          save: async (value) => {
            installation.parse(value);
            await tx.query(
              'INSERT INTO adaptive_package_installations(tenant_id,package_id,document) VALUES($1,$2,$3::jsonb) ON CONFLICT(tenant_id,package_id) DO UPDATE SET document=EXCLUDED.document',
              [context.tenantId, value.packageId, JSON.stringify(value)],
            );
          },
          receipt: async (id) => {
            z.string().uuid().parse(id);
            const row = (
              await tx.query<{ document: unknown }>(
                'SELECT document FROM adaptive_package_receipts WHERE tenant_id=$1 AND command_id=$2',
                [context.tenantId, id],
              )
            ).rows[0];

            return row ? receipt.parse(row.document) : null;
          },
          recordReceipt: async (value: PackageReceipt) => {
            receipt.parse(value);
            await tx.query(
              'INSERT INTO adaptive_package_receipts(tenant_id,command_id,document) VALUES($1,$2,$3::jsonb)',
              [context.tenantId, value.commandId, JSON.stringify(value)],
            );
          },
          event: async (c, id, before, after) => {
            await tx.query(
              'INSERT INTO adaptive_package_events(tenant_id,id,actor_id,before,after) VALUES($1,$2,$3,$4::jsonb,$5::jsonb)',
              [
                c.tenantId,
                id,
                c.actor.id,
                JSON.stringify(before),
                JSON.stringify(after),
              ],
            );
          },
          install: (c, d, p) => owners.install(scoped, c, d, p),
          remove: (c, i) => owners.remove(scoped, c, i),
        });
      }),
  };
}
