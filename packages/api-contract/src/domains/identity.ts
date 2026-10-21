import { apiAppsContract } from '../contracts/api-apps.js';
import { identityContract } from '../contracts/identity.js';
import { rolesContract } from '../contracts/roles.js';
import { settingsContract } from '../contracts/settings.js';

/** Routes served by `@luma/identity`. */
type IdentityContracts = {
  apiApps: typeof apiAppsContract;
  identity: typeof identityContract;
  roles: typeof rolesContract;
  settings: typeof settingsContract;
};

/** Routes served by `@luma/identity`, keyed by area. */
export const identityContracts: IdentityContracts = {
  apiApps: apiAppsContract,
  identity: identityContract,
  roles: rolesContract,
  settings: settingsContract,
};
