import { syncContract } from '../contracts/sync.js';

/** Routes served by `@luma/commerce-sync`. */
type CommerceSyncContracts = {
  sync: typeof syncContract;
};

/** Routes served by `@luma/commerce-sync`, keyed by area. */
export const commerceSyncContracts: CommerceSyncContracts = {
  sync: syncContract,
};
