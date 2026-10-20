import { randomUUID } from 'node:crypto';

import type { AtomicStore } from '@luma/platform';
import type { Pool, PoolClient } from 'pg';

import type {
  ApiAppReads,
  ApiAppRecord,
  ApiAppsRepository,
  ApiAppsTransaction,
  ApiCredential,
  ApiCredentials,
} from '../application/api-apps.js';
import {
  apiAppExpiryNoticeDays,
  apiAppRateLimits,
  apiAppReadWindowDays,
} from '../domain/api-apps.js';
import type { DataRegion } from '../domain/context.js';
import type { MembershipRow } from './access.js';
import { membershipFromRow, membershipSelect } from './access.js';
import { apiTokenRegion, hashApiToken } from './api-tokens.js';
import { createRequestCounter } from './rate-limit.js';
import { workspaceTransaction } from './settings.js';

type CredentialJson = Omit<ApiCredential, 'status'> & { status: string };

function credentialFromJson(
  value: CredentialJson | null,
): ApiCredential | null {
  if (!value) return null;
  // Unknown states fail closed as revoked.
  const status =
    value.status === 'active' || value.status === 'expired'
      ? value.status
      : 'revoked';

  return { ...value, status };
}

/**
 * Resolves bearer tokens through the functions owned by `luma_api_credentials`, which see every
 * workspace's credentials but return no hashes. Tokens with a bad format or checksum never reach
 * the database. Rate limits share the auth counters' store; without one, or with `limits` off,
 * each process counts alone or not at all.
 */
export function createApiCredentials(
  pool: Pool,
  region: DataRegion,
  limits: { enabled: boolean; store?: AtomicStore },
): ApiCredentials {
  const count = createRequestCounter(limits.store);

  return {
    async resolve(token) {
      const tokenRegion = apiTokenRegion(token);
      if (!tokenRegion) return { state: 'invalid' };
      if (tokenRegion !== region) return { state: 'other_cell' };
      const result = await pool.query<{ credential: CredentialJson | null }>(
        'SELECT api_credential_resolve($1) AS credential',
        [hashApiToken(token)],
      );
      const credential = credentialFromJson(result.rows[0]?.credential ?? null);

      return credential ? { state: 'found', credential } : { state: 'invalid' };
    },
    async find(tenantId, credentialId) {
      const result = await pool.query<{ credential: CredentialJson | null }>(
        'SELECT api_credential_find($1,$2) AS credential',
        [tenantId, credentialId],
      );

      return credentialFromJson(result.rows[0]?.credential ?? null);
    },
    async admit(tenantId, credentialId) {
      if (!limits.enabled) return null;
      const outcomes = await Promise.all(
        (
          [
            [`api-app:${credentialId}`, apiAppRateLimits.credential],
            [`api-workspace:${tenantId}`, apiAppRateLimits.workspace],
          ] as const
        ).map(async ([key, rule]) => {
          const window = await count(key, rule);

          return {
            limit: rule.max,
            remaining: rule.max - window.count,
            reset: window.resetIn,
          };
        }),
      );

      return outcomes.reduce((tightest, outcome) =>
        outcome.remaining < tightest.remaining ? outcome : tightest,
      );
    },
  };
}

type AppRow = {
  id: string;
  userId: string;
  name: string;
  scopes: string[];
  createdAt: Date;
  revokedAt: Date | null;
  ownerName: string | null;
  credentialId: string | null;
  lastFour: string | null;
  credentialCreatedAt: Date | null;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  credentialRevokedAt: Date | null;
  personalRequests: number;
  personalRecords: number;
};

// Each app with its newest credential, the member's recorded name and its recent personal data
// reads, through the (tenant_id, app_id, hour) index.
const appSelect = `SELECT a.id,a.user_id AS "userId",a.name,a.scopes,a.created_at AS "createdAt",a.revoked_at AS "revokedAt",
  NULLIF(p.name,'') AS "ownerName",c.id AS "credentialId",c.last_four AS "lastFour",c.created_at AS "credentialCreatedAt",
  c.expires_at AS "expiresAt",c.last_used_at AS "lastUsedAt",c.revoked_at AS "credentialRevokedAt",
  r.requests AS "personalRequests",r.records AS "personalRecords"
  FROM api_apps a
  LEFT JOIN workspace_people p ON p.tenant_id=a.tenant_id AND p.user_id=a.user_id
  LEFT JOIN LATERAL (SELECT c.id,c.last_four,c.created_at,c.expires_at,c.last_used_at,c.revoked_at FROM api_app_credentials c
    WHERE c.tenant_id=a.tenant_id AND c.app_id=a.id ORDER BY c.created_at DESC,c.id DESC LIMIT 1) c ON true
  CROSS JOIN LATERAL (SELECT COALESCE(sum(r.requests),0)::float8 AS requests,COALESCE(sum(r.records),0)::float8 AS records
    FROM api_app_personal_reads r WHERE r.tenant_id=a.tenant_id AND r.app_id=a.id
    AND r.hour>=now()-interval '${apiAppReadWindowDays} days') r
  WHERE a.tenant_id=$1`;

const iso = (value: Date | null) => value?.toISOString() ?? null;

function appFromRow(row: AppRow): ApiAppRecord & { ownerName: string | null } {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    scopes: row.scopes,
    createdAt: row.createdAt.toISOString(),
    revokedAt: iso(row.revokedAt),
    ownerName: row.ownerName,
    credential:
      row.credentialId &&
      row.lastFour &&
      row.credentialCreatedAt &&
      row.expiresAt
        ? {
            id: row.credentialId,
            lastFour: row.lastFour,
            createdAt: row.credentialCreatedAt.toISOString(),
            expiresAt: row.expiresAt.toISOString(),
            lastUsedAt: iso(row.lastUsedAt),
            revokedAt: iso(row.credentialRevokedAt),
          }
        : null,
    personalReads: {
      requests: row.personalRequests,
      records: row.personalRecords,
    },
  };
}

function transaction(tx: PoolClient, tenantId: string): ApiAppsTransaction {
  return {
    async member(userId) {
      const row = (
        await tx.query<MembershipRow>(
          `${membershipSelect} WHERE m.tenant_id=$1 AND m.user_id=$2`,
          [tenantId, userId],
        )
      ).rows[0];

      return row ? membershipFromRow(row) : null;
    },
    async list(userId) {
      const result = await tx.query<AppRow>(
        `${appSelect}${userId ? ' AND a.user_id=$2' : ''} ORDER BY a.created_at DESC,a.id DESC`,
        userId ? [tenantId, userId] : [tenantId],
      );

      return result.rows.map(appFromRow);
    },
    async app(id) {
      const row = (
        await tx.query<AppRow>(`${appSelect} AND a.id=$2`, [tenantId, id])
      ).rows[0];

      return row ? appFromRow(row) : null;
    },
    async openCount(userId) {
      const result = await tx.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM api_apps WHERE tenant_id=$1 AND user_id=$2 AND revoked_at IS NULL',
        [tenantId, userId],
      );

      return result.rows[0]?.count ?? 0;
    },
    async saveApp(app) {
      await tx.query(
        'INSERT INTO api_apps(tenant_id,id,user_id,name,scopes) VALUES($1,$2,$3,$4,$5)',
        [tenantId, app.id, app.userId, app.name, app.scopes],
      );
    },
    async saveCredential(credential) {
      await tx.query(
        'UPDATE api_app_credentials SET revoked_at=now() WHERE tenant_id=$1 AND app_id=$2 AND revoked_at IS NULL',
        [tenantId, credential.appId],
      );
      await tx.query(
        'INSERT INTO api_app_credentials(tenant_id,id,app_id,token_hash,last_four,expires_at) VALUES($1,$2,$3,$4,$5,$6)',
        [
          tenantId,
          credential.id,
          credential.appId,
          credential.hash,
          credential.lastFour,
          credential.expiresAt,
        ],
      );
    },
    async revoke(appId, actorId) {
      await tx.query(
        "UPDATE api_apps SET revoked_at=now(),revoked_by=$3,revoke_reason='revoked' WHERE tenant_id=$1 AND id=$2 AND revoked_at IS NULL",
        [tenantId, appId, actorId],
      );
      await tx.query(
        'UPDATE api_app_credentials SET revoked_at=now() WHERE tenant_id=$1 AND app_id=$2 AND revoked_at IS NULL',
        [tenantId, appId],
      );
    },
    async notifyRevoked(appId, userId) {
      await tx.query(
        "INSERT INTO workspace_mail(tenant_id,id,event_key,kind,user_id,target_id) VALUES($1,$2,$3,'api_app_revoked',$4,$5) ON CONFLICT(tenant_id,event_key) DO NOTHING",
        [tenantId, randomUUID(), `api-app-revoked:${appId}`, userId, appId],
      );
    },
    async command(id) {
      return (
        (
          await tx.query<{
            actorId: string;
            request: unknown;
            result: unknown;
          }>(
            'SELECT actor_id AS "actorId",request,result FROM workspace_commands WHERE tenant_id=$1 AND id=$2',
            [tenantId, id],
          )
        ).rows[0] ?? null
      );
    },
    async saveCommand(id, actorId, request, result) {
      await tx.query(
        'INSERT INTO workspace_commands(tenant_id,id,actor_id,request,result) VALUES($1,$2,$3,$4,$5)',
        [
          tenantId,
          id,
          actorId,
          JSON.stringify(request),
          JSON.stringify(result),
        ],
      );
    },
    async audit(actorId, type, target, before, after) {
      await tx.query(
        'INSERT INTO workspace_access_events(id,tenant_id,actor_id,event_type,target_id,before_value,after_value) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          randomUUID(),
          tenantId,
          actorId,
          type,
          target,
          JSON.stringify(before),
          JSON.stringify(after),
        ],
      );
    },
  };
}

/**
 * Stores API apps in serialized workspace transactions under tenant RLS. Requests restricted to
 * reads, such as support views, open them `READ ONLY`.
 */
export function createApiAppsRepository(
  pool: Pool,
  readOnly: () => boolean = () => false,
): ApiAppsRepository {
  return {
    transaction: (tenantId, userId, operation) =>
      workspaceTransaction(
        pool,
        tenantId,
        userId,
        (tx) => operation(transaction(tx, tenantId)),
        readOnly(),
      ),
  };
}

/**
 * Records personal data reads under tenant RLS in a short transaction of their own, so reads
 * never wait for the workspace lock. The first read of a route in an hour by a credential also
 * adds an `api_app.personal_data_read` access event naming the app and the route.
 */
export function createApiAppReads(pool: Pool): ApiAppReads {
  return {
    async record(read) {
      const tx = await pool.connect();
      try {
        await tx.query('BEGIN');
        await tx.query(
          "SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true)",
          [read.tenantId, read.userId],
        );
        const counted = await tx.query<{ first: boolean }>(
          `INSERT INTO api_app_personal_reads(tenant_id,credential_id,app_id,route,hour,requests,records)
          VALUES($1,$2,$3,$4,date_trunc('hour',now()),1,$5)
          ON CONFLICT(tenant_id,credential_id,route,hour) DO UPDATE
          SET requests=api_app_personal_reads.requests+1,records=api_app_personal_reads.records+EXCLUDED.records
          RETURNING xmax=0 AS first`,
          [
            read.tenantId,
            read.credentialId,
            read.appId,
            read.route,
            read.records,
          ],
        );
        if (counted.rows[0]?.first)
          await tx.query(
            `INSERT INTO workspace_access_events(id,tenant_id,actor_id,event_type,target_id,before_value,after_value)
            SELECT $1,$2,$3,'api_app.personal_data_read',a.id::text,NULL,jsonb_build_object('name',a.name,'path',$5::text,'credentialId',$6::text)
            FROM api_apps a WHERE a.tenant_id=$2 AND a.id=$4`,
            [
              randomUUID(),
              read.tenantId,
              read.userId,
              read.appId,
              read.route,
              read.credentialId,
            ],
          );
        await tx.query('COMMIT');
      } catch (error) {
        await tx.query('ROLLBACK');
        throw error;
      } finally {
        tx.release();
      }
    },
  };
}

/**
 * Queues an expiry notice for each token that expires within `apiAppExpiryNoticeDays` days and
 * hasn't had one, across workspaces; mail delivery rechecks the app before sending. Returns
 * how many were queued.
 */
export async function queueApiAppExpiryNotices(pool: Pool): Promise<number> {
  const result = await pool.query<{ queued: number }>(
    'SELECT api_apps_queue_expiry_notices($1) AS queued',
    [apiAppExpiryNoticeDays],
  );

  return result.rows[0]?.queued ?? 0;
}
