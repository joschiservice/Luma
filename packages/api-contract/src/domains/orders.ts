import { returnCasesContract } from '../contracts/return-cases.js';

/** Routes served by `@luma/orders`. */
type OrdersContracts = {
  returnCases: typeof returnCasesContract;
};

/** Routes served by `@luma/orders`, keyed by area. */
export const ordersContracts: OrdersContracts = {
  returnCases: returnCasesContract,
};
