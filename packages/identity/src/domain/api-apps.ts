import { forbidden, invalid } from '@luma/platform';

import type { Permission } from './permissions.js';
import { PermissionSet } from './roles.js';

/**
 * Permissions a personal API app can be granted: the read permissions of routes marked for the
 * public API. API apps reach no other route, and changes need action admission for apps first.
 * A test keeps this list equal to the permissions public routes require.
 */
export const apiAppScopes = [
  'orders.read',
  'fulfillment.read',
  'inventory.read',
  'products.read',
  'customers.read',
  'returns.read',
  'issues.read',
  'workflows.read',
  'activity.read',
] as const satisfies readonly Permission[];

export type ApiAppScope = (typeof apiAppScopes)[number];

/** How long a new or rotated credential stays valid, in days; every credential expires. */
export const apiAppLifetimes = [7, 30, 90, 180, 365] as const;

export type ApiAppLifetime = (typeof apiAppLifetimes)[number];

/**
 * An API app's state as callers see it. `expired` and `revoked` apps never authenticate again;
 * revoking is final, and an expired app needs a rotated credential.
 */
export type ApiAppStatus = 'active' | 'expired' | 'revoked';

const grantable: ReadonlySet<string> = new Set(apiAppScopes);

/** Reports whether a value is a permission an API app can be granted. */
function isApiAppScope(value: string): value is ApiAppScope {
  return grantable.has(value);
}

/**
 * Checks requested scopes and returns them sorted and deduplicated. Throws 400 for an empty
 * list or a permission API apps can't be granted, and 403 for one the person doesn't hold:
 * nobody grants an app more than they can do themselves.
 */
export function apiAppScopesFor(
  requested: readonly string[],
  holder: PermissionSet,
): ApiAppScope[] {
  const unique = [...new Set(requested)].sort();
  if (!unique.length) throw invalid('Choose at least one permission.');
  const unknown = unique.find((scope) => !isApiAppScope(scope));
  if (unknown) throw invalid(`API apps can’t be granted ${unknown}.`);
  const scopes = unique.filter(isApiAppScope);
  if (!scopes.every((scope) => holder.has(scope)))
    throw forbidden('You can only grant permissions you hold yourself.');

  return scopes;
}

/**
 * The permissions an API app acting for a person has on this request: its scopes that the
 * person's current role still grants. Losing a permission removes it from the app at once;
 * regaining it restores it. App permissions are never included.
 */
export function apiAppPermissions(
  member: PermissionSet,
  scopes: readonly string[],
): PermissionSet {
  return new PermissionSet(
    scopes.filter((scope) => isApiAppScope(scope) && member.has(scope)),
  );
}

/**
 * Requests API apps may send per minute, for one token and for all apps of a workspace. The
 * workspace limit keeps several tokens from adding up to more than one busy integration.
 */
export const apiAppRateLimits = {
  credential: { window: 60, max: 600 },
  workspace: { window: 60, max: 1800 },
} as const;

/** Days before expiry when the person an app acts for is reminded to replace its token. */
export const apiAppExpiryNoticeDays = 7;

/** Days of personal data reads that app listings sum up. */
export const apiAppReadWindowDays = 30;

/**
 * Whether a successful read through an API app touched customer personal data: the route can
 * return it and the app holds `customers.read`, without which those fields are left out.
 */
export function readsPersonalData(permissions: PermissionSet): boolean {
  return permissions.has('customers.read');
}

/**
 * The records a response returned: the length of a page's `items`, otherwise one record.
 * Counts are recorded; the records never are.
 */
export function recordsRead(body: unknown): number {
  if (
    typeof body === 'object' &&
    body !== null &&
    'items' in body &&
    Array.isArray(body.items)
  )
    return body.items.length;

  return 1;
}

/** The route template below the workspace, such as `/customers/{customerId}`. */
export function workspaceRoute(path: string): string {
  return path.replace(/^\/v\d+\/organizations\/\{organizationId\}/, '') || '/';
}
