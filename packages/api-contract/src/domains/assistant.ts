import { assistantContract } from '../contracts/assistant.js';

/** Routes served by `@luma/assistant`. */
type AssistantContracts = {
  assistant: typeof assistantContract;
};

/** Routes served by `@luma/assistant`, keyed by area. */
export const assistantContracts: AssistantContracts = {
  assistant: assistantContract,
};
