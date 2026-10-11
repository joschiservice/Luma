export {
  API_ROOT,
  API_VERSION,
  createClient,
  gmailFailure,
  type GmailClient,
  type GmailTransportOptions,
} from './client.js';

export {
  composeMessage,
  type ComposeAddress,
  type ComposeInput,
  encodeRaw,
  encodeWords,
  formatAddress,
} from './compose.js';

export { htmlToText } from './html.js';

export {
  decodeBase64,
  decodeWords,
  describeAttachment,
  findPart,
  maxTextLength,
  parseAddressList,
  parseMessage,
  type ParsedAddress,
  type ParsedAttachment,
  type ParsedMessage,
} from './mime.js';

export {
  authorizationUrl,
  canRead,
  canSend,
  codeChallenge,
  createOAuthClient,
  gmailScopes,
  type GmailOAuthClient,
  type OAuthConfig,
  type OAuthCredentials,
  readScope,
  REVOKE_URL,
  sendScope,
  TOKEN_URL,
} from './oauth.js';

export {
  createQuotaPacer,
  defaultUnitsPerSecond,
  type QuotaPacer,
  quotaUnits,
} from './pacer.js';

export {
  address,
  buildQuery,
  domain,
  type FilterSubject,
  labelName,
  mailboxFilter,
  type MailboxFilter,
  matchesFilter,
} from './query.js';

export { gmailId, type GmailMessage } from './schemas.js';

export { fail, parse } from '@luma/connector-core/transport';
