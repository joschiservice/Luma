export { createClient, type GmailClient } from './client.js';

export { composeMessage, encodeRaw } from './compose.js';

export {
  decodeBase64,
  describeAttachment,
  findPart,
  parseMessage,
  type ParsedMessage,
} from './mime.js';

export {
  authorizationUrl,
  canRead,
  canSend,
  createOAuthClient,
  type OAuthCredentials,
  readScope,
  sendScope,
} from './oauth.js';

export { createQuotaPacer, type QuotaPacer } from './pacer.js';

export { buildQuery, mailboxFilter, matchesFilter } from './query.js';

export { gmailId, type GmailMessage } from './schemas.js';

export { fail } from '@luma/connector-core/transport';
