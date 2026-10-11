import type { ProviderSimulator } from '@luma/simulator-core';

import {
  command,
  type GmailCommand,
  type GmailCommandResult,
} from './commands.js';
import { drift, handle, identify, rateLimit, unauthorized } from './http.js';
import type { GmailConfig } from './model.js';

export {
  type CommandAddress,
  type DeliverAttachment,
  type GmailCommand,
  GmailCommandError,
  type GmailCommandResult,
} from './commands.js';

export { csv, textPdf } from './documents.js';

export { gmailError, grantedScopes } from './http.js';

export { parseMime } from './mime.js';

export {
  type GmailConfig,
  type GmailContext,
  kinds,
  type MessageRecord,
  type ThreadRecord,
} from './model.js';

export { compileQuery } from './query.js';

/**
 * A simulated Gmail mailbox behind the Gmail API v1 subset Luma's adapter uses, plus Google's
 * OAuth token and revoke endpoints. Merchant commands seed the mailbox and deliver mail from
 * suppliers and customers.
 */
export const gmail: ProviderSimulator<
  GmailConfig,
  GmailCommand,
  GmailCommandResult
> = {
  kind: 'gmail',
  table: 'sim_gmail_records',
  identify,
  handle,
  command,
  unauthorized,
  drift,
  rateLimit,
};
