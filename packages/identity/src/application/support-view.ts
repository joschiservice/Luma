import type { SupportViewMode } from '../domain/context.js';
import type { Credentials } from './identity.js';

/** Why a support view ended. */
type SupportViewEndReason =
  'ended' | 'expired' | 'consent_revoked' | 'staff_access_revoked' | 'replaced';

/** The state of the view a cookie token names, checked on every request. */
export type SupportViewState =
  | {
      state: 'active';
      id: string;
      tenantId: string;
      userId: string;
      mode: SupportViewMode;
      expiresAt: string;
    }
  | { state: 'ended'; reason: SupportViewEndReason; tenantId: string }
  | { state: 'other'; tenantId: string }
  | { state: 'missing' };

/** Support view credentials and their storage. Only token hashes are stored. */
export interface SupportViewCredentials {
  /** Reads the support view token from request credentials, if present and well formed. */
  token(credentials: Credentials): string | null;
  /** Builds the `Set-Cookie` value that stores a token, or clears the cookie for `null`. */
  cookie(token: string | null): string;
  /**
   * Checks the view and ends it, with its evidence, when it is no longer valid. A `tenantId`
   * restricts it to one workspace; a `readPath` records the first read of that path.
   */
  resolve(
    token: string,
    tenantId: string | null,
    readPath: string | null,
    requestId: string,
  ): Promise<SupportViewState>;
  /** Exchanges a single-use handoff for a new cookie token; null when the handoff is unusable. */
  redeem(
    handoff: string,
    requestId: string,
  ): Promise<{ id: string; tenantId: string; token: string } | null>;
  /** Ends the view, recording who ended it as the view's staff member. */
  end(token: string, requestId: string): Promise<void>;
  /** Ends open views that are no longer valid; returns how many ended. */
  sweep(requestId: string): Promise<number>;
}
