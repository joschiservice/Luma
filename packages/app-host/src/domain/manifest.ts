import { appPermissionOwner, isPermission } from '@luma/identity';

import type { AppManifest } from '../application/contracts.js';

function invalid(appId: string, message: string): never {
  throw new Error(`Invalid manifest for app ${appId}: ${message}`);
}

/**
 * Checks the permission data an app declares: namespaced, unique app permissions; known core
 * scopes; and a core or own permission for every UI slot, decision kind and governed action.
 */
export function validateManifest(manifest: AppManifest) {
  const { id } = manifest;
  const own = new Set<string>();
  for (const permission of manifest.permissions) {
    if (isPermission(permission.key))
      invalid(id, `${permission.key} is a core permission`);
    const owner = appPermissionOwner(permission.key);
    if (owner === null) invalid(id, `${permission.key} is not <appId>:<name>`);
    if (owner !== id)
      invalid(id, `${permission.key} belongs to another app's namespace`);
    if (own.has(permission.key))
      invalid(id, `${permission.key} is declared twice`);
    if (!permission.label.trim() || !permission.description.trim())
      invalid(id, `${permission.key} needs a label and description`);
    own.add(permission.key);
  }
  for (const scope of manifest.scopes)
    if (!isPermission(scope))
      invalid(id, `scope ${scope} is not a core permission`);
  if (new Set(manifest.scopes).size !== manifest.scopes.length)
    invalid(id, 'scopes contain duplicates');
  const known = (key: string) => isPermission(key) || own.has(key);
  for (const slot of manifest.ui) {
    const permission = manifest.slotAccess[slot];
    if (!permission || !known(permission))
      invalid(id, `UI slot ${slot} must declare a known permission`);
  }
  for (const [kind, access] of Object.entries(manifest.decisionAccess ?? {}))
    if (!access || !known(access.view) || !known(access.respond))
      invalid(id, `decision kind ${kind} must declare known permissions`);
  for (const [capability, permission] of Object.entries(
    manifest.actionAccess ?? {},
  ))
    if (!permission || !known(permission))
      invalid(id, `action ${capability} must declare a known permission`);

  return own;
}
