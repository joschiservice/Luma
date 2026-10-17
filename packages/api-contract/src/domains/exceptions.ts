import { exceptionsContract } from '../contracts/cases.js';

/** Routes served by `@luma/exceptions`. */
type ExceptionsContracts = {
  exceptions: typeof exceptionsContract;
};

/** Routes served by `@luma/exceptions`, keyed by area. */
export const exceptionsContracts: ExceptionsContracts = {
  exceptions: exceptionsContract,
};
