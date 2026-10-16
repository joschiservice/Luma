import type { TenantContext } from '@luma/identity';

import type { RecordKind } from '../domain/linking.js';
import type { MailboxFilter } from '../domain/mailbox.js';
import type { MessageData } from '../domain/threads.js';

/** An installed connection that can read messages, as messaging needs it. */
export interface MailboxConnection {
  id: string;
  label: string;
  provider: string;
  status: 'pending' | 'active' | 'degraded' | 'disconnected' | 'revoked';
  /** Increases when credentials or grants change; a new version lifts a block. */
  version: number;
  /** The mailbox address, when the connection reports it. */
  address: string | null;
  canRead: boolean;
  canSend: boolean;
  /** The member who installed the connection, when known. */
  installerId: string | null;
}

/** Lists connections whose permissions include reading messages. */
export interface MailboxConnections {
  list(context: TenantContext): Promise<MailboxConnection[]>;
}

export type ReadResult =
  | {
      ok: true;
      /** Messages with the provider's message ID. */
      items: {
        providerMessageId: string;
        data: MessageData;
        observationId?: string;
        observedAt?: string;
      }[];
      /** True only when the provider reports a complete page. */
      complete?: boolean;
      nextCursor: string | null;
      retryAfterMs?: number | undefined;
    }
  | {
      ok: false;
      /** Connector failure code, such as `authentication` or `rate_limited`. */
      code: string;
      retryAfterMs?: number | undefined;
    };

/** Reads messages through the installed connection's capabilities. */
export interface MessageReader {
  /** One page of messages matching `filter` received at or after `receivedSince`. */
  messages(
    context: TenantContext,
    connectionId: string,
    input: {
      filter: MailboxFilter;
      receivedSince: string;
      cursor: string | null;
      limit: number;
    },
  ): Promise<ReadResult>;
  /** One page of every message in a provider thread. */
  thread(
    context: TenantContext,
    connectionId: string,
    input: {
      thread: { externalId: string; scopeKey: string };
      cursor: string | null;
    },
  ): Promise<ReadResult>;
}

export interface RecordRef {
  kind: RecordKind;
  id: string;
}

/**
 * Looks up other owners' records for linking and display. Reads are system reads: callers
 * decide whether the reader may see a record before showing its label.
 */
export interface RecordDirectory {
  /** Orders and purchase orders whose reference equals a key exactly (upper-case keys). */
  references(
    context: TenantContext,
    keys: string[],
  ): Promise<(RecordRef & { key: string })[]>;
  /** Customer profiles by lower-case email. */
  customers(
    context: TenantContext,
    emails: string[],
  ): Promise<{ email: string; id: string }[]>;
  /** Display labels keyed `kind:id`; records that do not exist are absent. */
  labels(
    context: TenantContext,
    records: RecordRef[],
  ): Promise<Map<string, string>>;
  /** Supplier of each purchase order. */
  orderSuppliers(
    context: TenantContext,
    orderIds: string[],
  ): Promise<Map<string, string>>;
}

/** Answers whether a member may own threads. */
export interface MemberDirectory {
  /** True when `userId` is an active member who can read messages. */
  canReadMessages(context: TenantContext, userId: string): Promise<boolean>;
}

/** Hands an inbound supplier message to procurement's message path. */
export interface ProcurementHandoff {
  /**
   * Records the message for the purchase order. `id` is deterministic, so retries record it
   * once. `forbidden` when the context may not manage procurement.
   */
  record(
    context: TenantContext,
    input: {
      purchaseOrderId: string;
      id: string;
      from: string;
      subject: string;
      body: string;
      receivedAt: string;
      messageId: string | null;
    },
  ): Promise<'recorded' | 'duplicate' | 'forbidden'>;
}
