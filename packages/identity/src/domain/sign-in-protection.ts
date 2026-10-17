/**
 * Failed password sign-ins one email address may collect before further password attempts are
 * refused. Failures count within a rolling window and only since the account's last successful
 * sign-in or password reset, so a lock ends on its own once older failures leave the window.
 */
export const passwordFailureLimit = { attempts: 10, windowMinutes: 15 };

/** Reports whether recorded password failures lock further attempts for the address. */
export function passwordSignInLocked(recentFailures: number) {
  return recentFailures >= passwordFailureLimit.attempts;
}

/**
 * Requests one client address may make per window, in seconds, on endpoints that check a
 * credential or send mail. Other auth endpoints keep Better Auth's general limit.
 */
export const authRateRules = {
  '/sign-in/email': { window: 60, max: 10 },
  '/sign-up/email': { window: 60, max: 5 },
  '/two-factor/verify-totp': { window: 60, max: 10 },
  '/two-factor/verify-backup-code': { window: 60, max: 10 },
  '/passkey/verify-authentication': { window: 60, max: 10 },
  '/send-verification-email': { window: 60, max: 3 },
  '/verify-email': { window: 60, max: 10 },
  '/request-password-reset': { window: 60, max: 3 },
  '/reset-password': { window: 60, max: 5 },
} as const;

/**
 * Request header in which the auth bridge passes the client address it trusts to Better Auth.
 * The bridge always overwrites it, so a client-sent value is never used.
 */
export const clientAddressHeader = 'x-luma-client-ip';
