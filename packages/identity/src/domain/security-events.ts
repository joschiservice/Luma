export const securityEventTypes = [
  'sign-in.password',
  'sign-in.passkey',
  'sign-in.two-factor',
  'two-factor.enabled',
  'two-factor.disabled',
  'two-factor.backup-codes-regenerated',
  'passkey.added',
  'passkey.removed',
  'password.changed',
  'sessions.revoked',
  'sessions.revoked-by-staff',
  'account.disabled',
  'account.enabled',
] as const;

export type SecurityEventType = (typeof securityEventTypes)[number];

export type SecurityEventOutcome = 'succeeded' | 'failed';

/**
 * Explains an outcome without recording what was submitted. Failed sign-ins carry a failure
 * category; successful two-factor sign-ins carry the factor used; revocations their scope.
 */
export type SecurityEventReason =
  | 'invalid-credentials'
  | 'invalid-code'
  | 'too-many-attempts'
  | 'locked'
  | 'challenge-expired'
  | 'passkey-rejected'
  | 'account-disabled'
  | 'rejected'
  | 'second-factor-required'
  | 'authenticator-code'
  | 'backup-code'
  | 'one'
  | 'others'
  | 'all';

/** A security event as written by identity. Either the user or the email hash may be known. */
export interface SecurityEventRecord {
  type: SecurityEventType;
  outcome: SecurityEventOutcome;
  reason: SecurityEventReason | null;
  userId: string | null;
  /** Keyed hash of the normalized email, only for failures that match no account. */
  emailHash: string | null;
  sessionId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string;
}

/** A recorded event as read back for the account it belongs to. */
export interface SecurityEvent {
  id: string;
  type: SecurityEventType;
  outcome: SecurityEventOutcome;
  reason: SecurityEventReason | null;
  sessionId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string;
  staffCommandId: string | null;
  createdAt: Date;
}

/** IP addresses and user agents are cleared after this many days; events are kept longer. */
export const securityEventNetworkRetentionDays = 90;

/** Events are deleted after this many days. */
export const securityEventRetentionDays = 365;

/** Maps a Better Auth sign-in error code to a failure category that reveals nothing submitted. */
export function signInFailureReason(
  code: string | undefined,
): SecurityEventReason {
  switch (code) {
    case 'INVALID_EMAIL_OR_PASSWORD':
      return 'invalid-credentials';
    case 'INVALID_CODE':
    case 'INVALID_BACKUP_CODE':
      return 'invalid-code';
    case 'TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE':
      return 'too-many-attempts';
    case 'ACCOUNT_TEMPORARILY_LOCKED':
      return 'locked';
    case 'INVALID_TWO_FACTOR_COOKIE':
      return 'challenge-expired';
    case 'ACCOUNT_DISABLED':
      return 'account-disabled';
    default:
      return 'rejected';
  }
}

/** Opaque position after the last event of a page, ordered newest first. */
export interface SecurityEventCursor {
  createdAt: Date;
  id: string;
}

/** Encodes a page position for callers; they treat it as opaque. */
export function encodeSecurityEventCursor(cursor: SecurityEventCursor) {
  return Buffer.from(
    `${cursor.createdAt.toISOString()}|${cursor.id}`,
    'utf8',
  ).toString('base64url');
}

/** Decodes a caller-supplied cursor, returning null when it is malformed. */
export function decodeSecurityEventCursor(
  value: string,
): SecurityEventCursor | null {
  const [time, id, extra] = Buffer.from(value, 'base64url')
    .toString('utf8')
    .split('|');
  const createdAt = new Date(time ?? '');
  if (
    extra !== undefined ||
    !id ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      id,
    ) ||
    Number.isNaN(createdAt.getTime())
  )
    return null;

  return { createdAt, id };
}
