import { salesContract } from '../contracts/sales.js';

/** Routes served by `@luma/sales`. */
type SalesContracts = {
  sales: typeof salesContract;
};

/** Routes served by `@luma/sales`, keyed by area. */
export const salesContracts: SalesContracts = {
  sales: salesContract,
};
