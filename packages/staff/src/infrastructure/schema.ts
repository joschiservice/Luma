import { boolean, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const time = (name: string) => timestamp(name, { withTimezone: true });

export const user = pgTable('staff_users', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: time('created_at').notNull(),
  updatedAt: time('updated_at').notNull(),
});

export const session = pgTable('staff_sessions', {
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
});

export const account = pgTable('staff_accounts', {
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

export const verification = pgTable('staff_verifications', {
  id: uuid('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: time('expires_at').notNull(),
  createdAt: time('created_at').notNull(),
  updatedAt: time('updated_at').notNull(),
});
