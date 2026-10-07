export {
  builtInMembership,
  hasPermission,
  IdentityError,
  makeTenantContext,
  requirePermission,
  requireTenant,
} from './domain/context.js';

export type {
  Membership,
  Organization,
  SessionIdentity,
  TenantContext,
} from './domain/context.js';

export {
  appPermissionOwner,
  isAppPermission,
  isPermission,
  permissionCatalog,
  permissionGroups,
} from './domain/permissions.js';

export type {
  AppPermission,
  Permission,
  PermissionDefinition,
} from './domain/permissions.js';

export {
  builtInReference,
  builtInRoles,
  PermissionSet,
} from './domain/roles.js';

export type { BuiltInRoleKey, RoleReference } from './domain/roles.js';

export type { Credentials, IdentityService } from './application/identity.js';

export type { SettingsService } from './application/settings.js';

export type {
  AppPermissionGroup,
  AppPermissionSource,
  RolesService,
} from './application/roles.js';

export type { MailProvider } from './application/mail.js';
