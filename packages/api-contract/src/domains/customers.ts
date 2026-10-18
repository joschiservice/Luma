import { customerErasuresContract } from '../contracts/customer-erasures.js';

/** Routes served by `@luma/customers`. */
type CustomersContracts = {
  customerErasures: typeof customerErasuresContract;
};

/** Routes served by `@luma/customers`, keyed by area. */
export const customersContracts: CustomersContracts = {
  customerErasures: customerErasuresContract,
};
