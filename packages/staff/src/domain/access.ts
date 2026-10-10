export const staffPermissions = [
  'staff.directory.read',
  'staff.workspace.inspect',
  'staff.sessions.revoke',
  'staff.audit.read',
  'staff.accounts.inspect',
  'staff.memberships.manage',
] as const;

export type StaffPermission = (typeof staffPermissions)[number];

export interface StaffContext {
  userId: string;
  sessionId: string;
  sessionCreatedAt: Date;
  permissions: StaffPermission[];
  requestId: string;
}

/** Staff errors carry a stable HTTP status without exposing database or credential details. */
export class StaffError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 404 | 409 | 503,
    message: string,
  ) {
    super(message);
  }
}

/** Checks explicit staff authority, independently of customer workspace roles. */
export function requireStaffPermission(
  context: StaffContext,
  permission: StaffPermission,
) {
  if (!context.permissions.includes(permission))
    throw new StaffError(403, 'Staff permission required.');
}

/** Commands that change customer access require authentication within the last fifteen minutes. */
export function requireRecentStaffSession(
  context: StaffContext,
  now = new Date(),
) {
  if (
    context.sessionCreatedAt.getTime() > now.getTime() ||
    now.getTime() - context.sessionCreatedAt.getTime() > 15 * 60_000
  )
    throw new StaffError(403, 'Sign in again before changing customer access.');
}
