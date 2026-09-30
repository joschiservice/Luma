import { randomUUID } from 'node:crypto';

import { requireRole, requireTenant } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';
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

const iso = (value: Date | null) => value?.toISOString() ?? null;

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
 * Stores the current customer profile per connection and source customer. Erased customers
 * are remembered by a digest of their source ID so later reads cannot restore them.
 */
export function createCustomerProfiles(db: TenantDatabase): CustomerProfiles {
  return {
    async upsert(context, input) {
      requireRole(context, ['owner', 'admin']);
      const value = profileSchema.parse(input);

      return db.transaction(context.tenantId, async (tx) => {
        const tenant = context.tenantId;
        const keys = [tenant, value.connectionId, value.externalId];
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
    async erase(context, connectionId, externalIds) {
      requireRole(context, ['owner', 'admin']);
      z.string().uuid().parse(connectionId);
      if (externalIds)
        z.array(z.string().min(1).max(1024)).max(10000).parse(externalIds);

      return db.transaction(context.tenantId, async (tx) => {
        if (externalIds?.length)
          await tx.query(
            `INSERT INTO customer_erasures(tenant_id,connection_id,external_digest)
            SELECT $1,$2,sha256(convert_to(id,'UTF8')) FROM unnest($3::text[]) id ON CONFLICT DO NOTHING`,
            [context.tenantId, connectionId, externalIds],
          );
        const removed = await tx.query(
          `DELETE FROM customer_profiles WHERE tenant_id=$1 AND connection_id=$2
          AND ($3::text[] IS NULL OR external_id=ANY($3))`,
          [context.tenantId, connectionId, externalIds ?? null],
        );

        return removed.rowCount ?? 0;
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
