import { identityContract } from '../contracts/identity.js';
import { rolesContract } from '../contracts/roles.js';
import { settingsContract } from '../contracts/settings.js';

/** Routes served by `@luma/identity`. */
type IdentityContracts = {
  identity: typeof identityContract;
  roles: typeof rolesContract;
  settings: typeof settingsContract;
};

/** Routes served by `@luma/identity`, keyed by area. */
export const identityContracts: IdentityContracts = {
  identity: identityContract,
  roles: rolesContract,
  settings: settingsContract,
};
