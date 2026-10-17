import { messagingContract } from '../contracts/messaging.js';

/** Routes served by `@luma/messaging`. */
type MessagingContracts = {
  messaging: typeof messagingContract;
};

/** Routes served by `@luma/messaging`, keyed by area. */
export const messagingContracts: MessagingContracts = {
  messaging: messagingContract,
};
