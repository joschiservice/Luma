export {
  AccountDisabledError,
  AccountErasedError,
  builtInMembership,
  hasPermission,
  isOwner,
  IdentityError,
  makeTenantContext,
  MembershipSuspendedError,
  pausesBackgroundWork,
  requireChangesAllowed,
  requirePermission,
  requireTenant,
  WorkspaceInactiveError,
} from './domain/context.js';

export type { Membership, TenantContext } from './domain/context.js';

export {
  appPermissionOwner,
  isAppPermission,
  isPermission,
} from './domain/permissions.js';

export type { Permission } from './domain/permissions.js';

export { PermissionSet } from './domain/roles.js';

export { describeUserAgent } from './domain/sessions.js';

export {
  decodeSecurityEventCursor,
  encodeSecurityEventCursor,
} from './domain/security-events.js';

export type { SecurityEventType } from './domain/security-events.js';

export type { IdentityService } from './application/identity.js';

export { MailRateLimited } from './application/mail.js';

export type { SettingsService } from './application/settings.js';

export type { AppPermissionGroup, RolesService } from './application/roles.js';

export {
  changeAccountDeletionForSupport,
  changeAccountForSupport,
  changeMembershipForSupport,
  revokeCustomerSessionsForSupport,
} from './application/support.js';

export type {
  AccountDeletionCategory,
  AccountDeletionCommand,
  AccountDisableCategory,
  SupportAccountDeletion,
  SupportAccountChange,
  SupportMembershipChange,
  SupportSessionRevocation,
} from './application/support.js';
