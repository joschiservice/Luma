import type {
  AttachmentContent,
  ExternalId,
  MailboxFilter,
  MessageAddress,
  MessageSnapshot,
  Page,
  PageQuery,
  WriteReceipt,
} from './capabilities.js';

/** A reply or new message Luma asks the mailbox to send. */
interface OutboundMessage {
  /**
   * Luma's outbound ID. Adapters derive the RFC Message-ID from it and refuse to send when the
   * mailbox already holds a message with that ID.
   */
  outboundId: string;
  thread: ExternalId | null;
  inReplyTo: string | null;
  references: string[];
  to: MessageAddress[];
  cc: MessageAddress[];
  subject: string;
  text: string;
  attachments?: { filename: string; mimeType: string; base64: string }[];
}

/** Mailbox reads and sends. Messages are personal data, never commerce observations. */
export interface MessageCapabilities {
  /** Messages matching `filter` received at or after `receivedSince`. Resource `message`. */
  'messages.read': {
    input: PageQuery & { filter: MailboxFilter; receivedSince: string };
    output: Page<MessageSnapshot>;
  };
  /** Every message of one thread, for refreshing a thread and verifying sends. */
  'message-threads.read': {
    input: PageQuery & { thread: ExternalId };
    output: Page<MessageSnapshot>;
  };
  /** Reads one attachment; fails with `invalid_request` above `maxBytes`. */
  'message-attachments.read': {
    input: { message: ExternalId; attachment: ExternalId; maxBytes: number };
    output: AttachmentContent;
  };
  /** Acceptance means the provider accepted the message, not that anyone received it. */
  'messages.send': { input: OutboundMessage; output: WriteReceipt };
}
