import { randomUUID } from 'node:crypto';

import { requirePermission, requireTenant } from '@luma/identity';
import type { SqlTransaction, TenantDatabase } from '@luma/platform';
import { z } from 'zod';

import type {
  CustomerProfiles,
  StoredCustomerProfile,
} from '../application/profiles.js';
import { replacesProfile } from '../domain/profiles.js';

const text = (max: number) => z.string().min(1).max(max).nullable();

const timestamp = z.string().datetime({ offset: true });

const profileSchema = z
  .object({
    connectionId: z.string().uuid(),
    externalId: z.string().min(1).max(1024),
    displayName: text(512),
    email: text(320),
    phone: text(100),
    address: z
      .object({
        line1: text(512),
        line2: text(512),
        city: text(256),
        region: text(256),
        postalCode: text(64),
        country: text(128),
      })
      .strict()
      .nullable(),
    state: z.enum(['enabled', 'disabled', 'invited', 'declined', 'unknown']),
    sourceCreatedAt: timestamp.nullable(),
    orderCount: z.number().int().min(0).nullable(),
    amountSpent: z
      .object({
        amount: z.string().regex(/^-?\d{1,14}(\.\d{1,6})?$/),
        currency: z.string().regex(/^[A-Z]{3}$/),
      })
      .strict()
      .nullable(),
    tags: z.array(z.string().min(1).max(255)).max(250),
    shared: z.object({ contact: z.boolean(), address: z.boolean() }).strict(),
    sourceUpdatedAt: timestamp.nullable(),
    observedAt: timestamp,
    observationId: z.string().uuid(),
  })
  .strict()
  // Withheld groups must stay empty so a later approval change cannot leak older values.
  .refine(
    (v) =>
      (v.shared.contact || (!v.displayName && !v.email && !v.phone)) &&
      (v.shared.address || v.address === null),
  );

type Row = {
  id: string;
  connection_id: string;
  external_id: string;
  display_name: string | null;
  email: string | null;
  phone: string | null;
  address: StoredCustomerProfile['address'];
  state: StoredCustomerProfile['state'];
  source_created_at: Date | null;
  order_count: number | null;
  amount_spent: string | null;
  currency: string | null;
  tags: string[];
  contact_shared: boolean;
  address_shared: boolean;
  source_updated_at: Date | null;
  observed_at: Date;
  observation_id: string;
  updated_at: Date;
};

const orderSchema = z
  .object({
    order: z
      .object({
        externalId: z.string().min(1).max(1024),
        scopeKey: z.string().max(1024),
      })
      .strict(),
    customerExternalId: z.string().min(1).max(1024).nullable(),
    observedAt: timestamp,
  })
  .strict();

const iso = (value: Date | null) => value?.toISOString() ?? null;

// Erasure and imports of one connection's customers serialize, so a read that started before
// an erasure cannot store data the erasure already removed.
const lockConnection = (
  tx: SqlTransaction,
  tenantId: string,
  connectionId: string,
) =>
  tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `customers:${tenantId}:${connectionId}`,
  ]);

// Deletes profiles and order links of one connection, or only of the listed source customers.
async function deleteCustomers(
  tx: SqlTransaction,
  tenantId: string,
  connectionId: string,
  externalIds: string[] | null,
) {
  await tx.query(
    `DELETE FROM customer_orders WHERE tenant_id=$1 AND connection_id=$2
    AND ($3::text[] IS NULL OR customer_external_id=ANY($3))`,
    [tenantId, connectionId, externalIds],
  );
  const removed = await tx.query(
    `DELETE FROM customer_profiles WHERE tenant_id=$1 AND connection_id=$2
    AND ($3::text[] IS NULL OR external_id=ANY($3))`,
    [tenantId, connectionId, externalIds],
  );

  return removed.rowCount ?? 0;
}

// Stored as exact decimals; strip the scale padding PostgreSQL adds.
const decimal = (value: string) =>
  value.includes('.') ? value.replace(/\.?0+$/, '') : value;

function stored(row: Row): StoredCustomerProfile {
  return {
    id: row.id,
    connectionId: row.connection_id,
    externalId: row.external_id,
    displayName: row.display_name,
    email: row.email,
    phone: row.phone,
    address: row.address,
    state: row.state,
    sourceCreatedAt: iso(row.source_created_at),
    orderCount: row.order_count,
    amountSpent:
      row.amount_spent !== null && row.currency
        ? { amount: decimal(row.amount_spent), currency: row.currency }
        : null,
    tags: row.tags,
    shared: { contact: row.contact_shared, address: row.address_shared },
    sourceUpdatedAt: iso(row.source_updated_at),
    observedAt: row.observed_at.toISOString(),
    observationId: row.observation_id,
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Stores the current customer profile per connection and source customer, and which source
 * customer placed each order. Erased customers are remembered by a digest of their source ID
 * so later reads cannot restore them or their order links.
 */
export function createCustomerProfiles(db: TenantDatabase): CustomerProfiles {
  return {
    async upsert(context, input) {
      requirePermission(context, 'sync.manage');
      const value = profileSchema.parse(input);

      return db.transaction(context.tenantId, async (tx) => {
        const tenant = context.tenantId;
        const keys = [tenant, value.connectionId, value.externalId];
        await lockConnection(tx, tenant, value.connectionId);
        const erased = await tx.query(
          `SELECT 1 FROM customer_erasures WHERE tenant_id=$1 AND connection_id=$2
          AND external_digest=sha256(convert_to($3,'UTF8'))`,
          keys,
        );
        if (erased.rowCount) return 'suppressed';
        const current = (
          await tx.query<{
            observation_id: string;
            source_updated_at: Date | null;
            observed_at: Date;
          }>(
            `SELECT observation_id,source_updated_at,observed_at FROM customer_profiles
            WHERE tenant_id=$1 AND connection_id=$2 AND external_id=$3 FOR UPDATE`,
            keys,
          )
        ).rows[0];
        if (
          current &&
          !replacesProfile(value, {
            observationId: current.observation_id,
            sourceUpdatedAt: iso(current.source_updated_at),
            observedAt: current.observed_at.toISOString(),
          })
        )
          return 'retained';
        await tx.query(
          `INSERT INTO customer_profiles(tenant_id,connection_id,external_id,id,display_name,email,phone,address,state,
            source_created_at,order_count,amount_spent,currency,tags,contact_shared,address_shared,source_updated_at,
            observed_at,observation_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
          ON CONFLICT(tenant_id,connection_id,external_id) DO UPDATE SET display_name=EXCLUDED.display_name,
            email=EXCLUDED.email,phone=EXCLUDED.phone,address=EXCLUDED.address,state=EXCLUDED.state,
            source_created_at=EXCLUDED.source_created_at,order_count=EXCLUDED.order_count,
            amount_spent=EXCLUDED.amount_spent,currency=EXCLUDED.currency,tags=EXCLUDED.tags,
            contact_shared=EXCLUDED.contact_shared,address_shared=EXCLUDED.address_shared,
            source_updated_at=EXCLUDED.source_updated_at,observed_at=EXCLUDED.observed_at,
            observation_id=EXCLUDED.observation_id,updated_at=now()`,
          [
            ...keys,
            randomUUID(),
            value.displayName,
            value.email,
            value.phone,
            value.address,
            value.state,
            value.sourceCreatedAt,
            value.orderCount,
            value.amountSpent?.amount ?? null,
            value.amountSpent?.currency ?? null,
            value.tags,
            value.shared.contact,
            value.shared.address,
            value.sourceUpdatedAt,
            value.observedAt,
            value.observationId,
          ],
        );

        return 'applied';
      });
    },
    async recordOrders(context, connectionId, orders) {
      requirePermission(context, 'sync.manage');
      z.string().uuid().parse(connectionId);
      const values = z
        .array(orderSchema)
        .max(1000)
        .refine(
          (items) =>
            new Set(
              items.map((item) =>
                JSON.stringify([item.order.scopeKey, item.order.externalId]),
              ),
            ).size === items.length,
          { message: 'Each order may appear once' },
        )
        .parse(orders);
      if (!values.length) return;
      const columns = [
        values.map((item) => item.order.scopeKey),
        values.map((item) => item.order.externalId),
        values.map((item) => item.customerExternalId),
        values.map((item) => item.observedAt),
      ];
      const rows = `unnest($3::text[],$4::text[],$5::text[],$6::timestamptz[]) AS v(scope_key,external_id,customer,observed_at)`;
      const erased = `EXISTS (SELECT 1 FROM customer_erasures x WHERE x.tenant_id=$1 AND x.connection_id=$2
        AND x.external_digest=sha256(convert_to(v.customer,'UTF8')))`;

      await db.transaction(context.tenantId, async (tx) => {
        await lockConnection(tx, context.tenantId, connectionId);
        await tx.query(
          `DELETE FROM customer_orders o USING ${rows}
          WHERE o.tenant_id=$1 AND o.connection_id=$2 AND o.order_scope_key=v.scope_key
          AND o.order_external_id=v.external_id AND o.observed_at<=v.observed_at
          AND (v.customer IS NULL OR ${erased})`,
          [context.tenantId, connectionId, ...columns],
        );
        await tx.query(
          `INSERT INTO customer_orders(tenant_id,connection_id,order_scope_key,order_external_id,customer_external_id,observed_at)
          SELECT $1,$2,v.scope_key,v.external_id,v.customer,v.observed_at FROM ${rows}
          WHERE v.customer IS NOT NULL AND NOT ${erased}
          ON CONFLICT(tenant_id,connection_id,order_scope_key,order_external_id) DO UPDATE
          SET customer_external_id=EXCLUDED.customer_external_id,observed_at=EXCLUDED.observed_at
          WHERE customer_orders.observed_at<=EXCLUDED.observed_at`,
          [context.tenantId, connectionId, ...columns],
        );
      });
    },
    async erase(context, connectionId, externalIds) {
      requirePermission(context, 'sync.manage');
      z.string().uuid().parse(connectionId);
      if (externalIds)
        z.array(z.string().min(1).max(1024)).max(10000).parse(externalIds);

      return db.transaction(context.tenantId, async (tx) => {
        await lockConnection(tx, context.tenantId, connectionId);
        if (externalIds?.length)
          await tx.query(
            `INSERT INTO customer_erasures(tenant_id,connection_id,external_digest)
            SELECT $1,$2,sha256(convert_to(id,'UTF8')) FROM unnest($3::text[]) id ON CONFLICT DO NOTHING`,
            [context.tenantId, connectionId, externalIds],
          );

        return deleteCustomers(
          tx,
          context.tenantId,
          connectionId,
          externalIds ?? null,
        );
      });
    },
    async remove(context, connectionId, externalIds) {
      requirePermission(context, 'sync.manage');
      z.string().uuid().parse(connectionId);
      z.array(z.string().min(1).max(1024)).max(1000).parse(externalIds);
      if (!externalIds.length) return 0;

      return db.transaction(context.tenantId, async (tx) => {
        await lockConnection(tx, context.tenantId, connectionId);

        return deleteCustomers(tx, context.tenantId, connectionId, externalIds);
      });
    },
    async list(context, query) {
      requireTenant(context, context.tenantId);
      const input = z
        .object({
          q: z.string().trim().max(120).optional(),
          connectionId: z.string().uuid().optional(),
          limit: z.number().int().min(1).max(100),
        })
        .parse(query);
      const prefix = input.q
        ? `${input.q.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`
        : null;

      return db.transaction(context.tenantId, async (tx) =>
        (
          await tx.query<Row>(
            `SELECT * FROM customer_profiles WHERE tenant_id=$1
            AND ($2::uuid IS NULL OR connection_id=$2)
            AND ($3::text IS NULL OR email_key LIKE $3 OR lower(display_name) LIKE $3)
            ORDER BY source_created_at DESC NULLS LAST,id LIMIT $4`,
            [context.tenantId, input.connectionId ?? null, prefix, input.limit],
          )
        ).rows.map(stored),
      );
    },
  };
}
