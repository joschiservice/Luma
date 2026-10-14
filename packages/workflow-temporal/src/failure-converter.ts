import { DefaultFailureConverter } from '@temporalio/common';

// Error text and stacks are payloads too; encrypt them before writing workflow history.
export const failureConverter = new DefaultFailureConverter({
  encodeCommonAttributes: true,
});
