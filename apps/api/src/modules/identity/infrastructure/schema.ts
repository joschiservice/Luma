import { boolean, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const time = (name: string) => timestamp(name, { withTimezone: true });

export const user = pgTable('users', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
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
  dataRegion: text('data_region').notNull().default('EU'),
  status: text('status').notNull().default('active'),
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
  createdAt: time('created_at').notNull(),
});

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
