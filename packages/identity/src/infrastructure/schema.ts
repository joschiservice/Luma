import {
  bigint,
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

const time = (name: string) => timestamp(name, { withTimezone: true });

export const user = pgTable('users', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  dataRegion: text('confirmed_data_region'),
  regionConfirmedAt: time('region_confirmed_at'),
  twoFactorEnabled: boolean('two_factor_enabled').notNull().default(false),
  createdAt: time('created_at').notNull(),
  updatedAt: time('updated_at').notNull(),
});

export const session = pgTable('sessions', {
  id: uuid('id').primaryKey(),
  token: text('token').notNull().unique(),
  userId: uuid('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  expiresAt: time('expires_at').notNull(),
  createdAt: time('created_at').notNull(),
  updatedAt: time('updated_at').notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  activeOrganizationId: uuid('active_organization_id'),
  lastActiveAt: time('last_active_at'),
});

export const account = pgTable('accounts', {
  id: uuid('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: uuid('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: time('access_token_expires_at'),
  refreshTokenExpiresAt: time('refresh_token_expires_at'),
  scope: text('scope'),
  password: text('password'),
  createdAt: time('created_at').notNull(),
  updatedAt: time('updated_at').notNull(),
});

export const verification = pgTable('verifications', {
  id: uuid('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: time('expires_at').notNull(),
  createdAt: time('created_at').notNull(),
  updatedAt: time('updated_at').notNull(),
});

export const organization = pgTable('organizations', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  logo: text('logo'),
  metadata: text('metadata'),
  createdAt: time('created_at').notNull(),
  dataRegion: text('data_region').notNull(),
  status: text('status').notNull().default('active'),
  /** Announced by the retention pass for a closed workspace; never moves earlier. */
  dataDeletionAt: time('data_deletion_at'),
  dataPurgedAt: time('data_purged_at'),
});

export const member = pgTable('memberships', {
  id: uuid('id').primaryKey(),
  organizationId: uuid('tenant_id')
    .notNull()
    .references(() => organization.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  customRoleId: uuid('custom_role_id'),
  status: text('status').notNull().default('active'),
  createdAt: time('created_at').notNull(),
});

// Required by Better Auth's organization plugin; Luma uses workspace_invitations instead.
export const invitation = pgTable('invitations', {
  id: uuid('id').primaryKey(),
  organizationId: uuid('tenant_id')
    .notNull()
    .references(() => organization.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  role: text('role'),
  status: text('status').notNull(),
  inviterId: uuid('inviter_id')
    .notNull()
    .references(() => user.id),
  expiresAt: time('expires_at').notNull(),
  createdAt: time('created_at').notNull(),
});

export const twoFactor = pgTable('two_factors', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => user.id, { onDelete: 'cascade' }),
  secret: text('secret').notNull(),
  backupCodes: text('backup_codes').notNull(),
  verified: boolean('verified').notNull().default(true),
  failedVerificationCount: integer('failed_verification_count')
    .notNull()
    .default(0),
  lockedUntil: time('locked_until'),
});

export const passkey = pgTable('passkeys', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  name: text('name'),
  credentialID: text('credential_id').notNull().unique(),
  publicKey: text('public_key').notNull(),
  counter: bigint('counter', { mode: 'number' }).notNull(),
  deviceType: text('device_type').notNull(),
  backedUp: boolean('backed_up').notNull(),
  transports: text('transports'),
  aaguid: text('aaguid'),
  createdAt: time('created_at'),
});
