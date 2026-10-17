import { appsContract } from '../contracts/apps.js';
import { stockProtectionContract } from '../contracts/stock-protection.js';

/** Routes served by `@luma/app-host`. */
type AppHostContracts = {
  apps: typeof appsContract;
  stockProtection: typeof stockProtectionContract;
};

/** Routes served by `@luma/app-host`, keyed by area. */
export const appHostContracts: AppHostContracts = {
  apps: appsContract,
  stockProtection: stockProtectionContract,
};
