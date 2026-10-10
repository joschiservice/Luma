import { createHash, randomBytes } from 'node:crypto';

import type { Pool } from 'pg';

import type { Credentials } from '../application/identity.js';
import type {
  SupportViewCredentials,
  SupportViewState,
} from '../application/support-view.js';

const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');

/** Support view lifetime; the cookie never outlives the view. */
const viewSeconds = 30 * 60;

/**
 * Reads and writes support view credentials: a host-only, HttpOnly, `SameSite=Strict` cookie
 * whose name derives from the auth cookie prefix, and the SQL functions owned by
 * `luma_support_view`. Only token hashes reach the database.
 */
export function createSupportViewCredentials(
  pool: Pool,
  settings: { baseURL: string; cookiePrefix?: string | undefined },
): SupportViewCredentials {
  const secure = new URL(settings.baseURL).protocol === 'https:';
  // `__Host-` binds the cookie to this exact host over HTTPS, without a Domain attribute.
  const name = `${secure ? '__Host-' : ''}${settings.cookiePrefix ?? 'luma'}.support_view`;

  return {
    token(credentials: Credentials) {
      const header = credentials.cookie;
      if (!header) return null;
      for (const part of header.split(';')) {
        const separator = part.indexOf('=');
        if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
        const value = part.slice(separator + 1).trim();

        return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
      }

      return null;
    },
    cookie(token) {
      return [
        `${name}=${token ?? ''}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Strict',
        `Max-Age=${token ? viewSeconds : 0}`,
        ...(secure ? ['Secure'] : []),
      ].join('; ');
    },
    async resolve(token, tenantId, readPath, requestId) {
      const result = await pool.query<{ view: SupportViewState }>(
        'SELECT support_view_resolve($1,$2,$3,$4) AS view',
        [hash(token), tenantId, readPath, requestId],
      );

      return result.rows[0]!.view;
    },
    async redeem(handoff, requestId) {
      if (!/^[A-Za-z0-9_-]{43}$/.test(handoff)) return null;
      const token = randomBytes(32).toString('base64url');
      const result = await pool.query<{
        view: { id: string; tenantId: string } | null;
      }>('SELECT support_view_redeem($1,$2,$3) AS view', [
        hash(handoff),
        hash(token),
        requestId,
      ]);
      const view = result.rows[0]?.view;

      return view ? { ...view, token } : null;
    },
    async end(token, requestId) {
      await pool.query('SELECT support_view_end($1,$2)', [
        hash(token),
        requestId,
      ]);
    },
    async sweep(requestId) {
      const result = await pool.query<{ ended: number }>(
        'SELECT support_view_sweep($1) AS ended',
        [requestId],
      );

      return result.rows[0]?.ended ?? 0;
    },
  };
}
