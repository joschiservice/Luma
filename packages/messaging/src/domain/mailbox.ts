/** Mailbox rules, read windows and reading state. Pure functions over stored mailbox state. */

export type RuleKind =
  'sender_domain' | 'sender_address' | 'recipient_address' | 'label';

export type RuleParty =
  | { kind: 'supplier'; supplierId: string }
  | { kind: 'customer' }
  | { kind: 'other' };

export interface MailboxRule {
  id: string;
  connectionId: string;
  kind: RuleKind;
  value: string;
  party: RuleParty;
  /** When older messages for this rule were read; null until the first complete read. */
  backfilledAt: string | null;
  createdBy: string;
  createdAt: string;
}

export interface MailboxSettings {
  backfillDays: number;
  replyHours: number;
  approveAll: boolean;
}

export const defaultSettings: MailboxSettings = {
  backfillDays: 30,
  replyHours: 24,
  approveAll: false,
};

/** A read that has started and continues from `page` after a restart. */
export interface ScanCursor {
  kind: 'initial' | 'incremental' | 'backfill';
  /** Earliest receive time the scan asks for. */
  since: string;
  /** Scan start; becomes `coveredUntil` once an initial or incremental scan completes. */
  startedAt: string;
  /** Rules whose filter the scan uses. */
  ruleIds: string[];
  /** Provider page cursor; null for the first page. */
  page: string | null;
}

export interface MailboxCursor {
  /** Messages received before this time are read for every backfilled rule. */
  coveredUntil?: string;
  scan?: ScanCursor;
  /** Connection version that was blocked; a different version lifts the block. */
  blockedVersion?: number;
}

/** Stored mailbox state, one per connection that can read messages. */
export interface Mailbox {
  tenantId: string;
  connectionId: string;
  principalId: string;
  label: string;
  provider: string;
  address: string | null;
  settings: MailboxSettings;
  cursor: MailboxCursor;
  paused: boolean;
  blocked: BlockReason | null;
  dueAt: string;
  hintAt: string | null;
  leaseToken: string | null;
  leaseUntil: string | null;
  attempts: number;
  lastSyncedAt: string | null;
  lastError: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/** Why reading stopped until someone acts. */
export type BlockReason =
  | 'authentication'
  | 'permission_denied'
  | 'unsupported_capability'
  | 'principal_unavailable';

/** Which messages a provider read returns; mirrors the connection capability filter. */
export interface MailboxFilter {
  senderDomains: string[];
  senderAddresses: string[];
  recipientAddresses: string[];
  labels: string[];
  includeSent: boolean;
}

/** Overlap with the previous read, for provider clock skew and late indexing. */
export const overlapMs = 10 * 60_000;

/** Longest pause after repeated failures. */
export const maxBackoffMs = 60 * 60_000;

/**
 * Builds the provider filter from rules. The provider applies it, so Luma never receives
 * messages outside the rules; sent messages to the same correspondents are always included.
 */
export function mailboxFilter(rules: readonly MailboxRule[]): MailboxFilter {
  const values = (kind: RuleKind) =>
    [
      ...new Set(
        rules
          .filter((rule) => rule.kind === kind)
          .map((rule) =>
            kind === 'label' ? rule.value : rule.value.toLowerCase(),
          ),
      ),
    ].sort();

  return {
    senderDomains: values('sender_domain'),
    senderAddresses: values('sender_address'),
    recipientAddresses: values('recipient_address'),
    labels: values('label'),
    includeSent: true,
  };
}

/**
 * Chooses the next read: continue a started scan, read the backfill window on the first read,
 * read older messages for rules added since, or read what arrived since the covered time.
 * Returns null when there are no rules. A scan whose rules were removed restarts.
 */
export function planScan(
  mailbox: Pick<Mailbox, 'cursor' | 'settings'>,
  rules: readonly MailboxRule[],
  now: Date,
): ScanCursor | null {
  if (!rules.length) return null;
  const active = new Set(rules.map((rule) => rule.id));
  const current = mailbox.cursor.scan;
  if (current && current.ruleIds.every((id) => active.has(id))) return current;
  const backfillSince = new Date(
    now.getTime() - mailbox.settings.backfillDays * 86_400_000,
  ).toISOString();
  const startedAt = now.toISOString();
  if (!mailbox.cursor.coveredUntil)
    return {
      kind: 'initial',
      since: backfillSince,
      startedAt,
      ruleIds: rules.map((rule) => rule.id),
      page: null,
    };
  const fresh = rules.filter((rule) => !rule.backfilledAt);
  if (fresh.length)
    return {
      kind: 'backfill',
      since: backfillSince,
      startedAt,
      ruleIds: fresh.map((rule) => rule.id),
      page: null,
    };

  return {
    kind: 'incremental',
    since: new Date(
      Date.parse(mailbox.cursor.coveredUntil) - overlapMs,
    ).toISOString(),
    startedAt,
    ruleIds: rules.map((rule) => rule.id),
    page: null,
  };
}

/** Exponential backoff from 30 seconds to an hour, or the provider's advice when longer. */
export function backoffMs(attempts: number, retryAfterMs?: number) {
  const exponential = Math.min(
    maxBackoffMs,
    30_000 * 2 ** Math.max(0, Math.min(attempts - 1, 12)),
  );

  return Math.min(maxBackoffMs, Math.max(exponential, retryAfterMs ?? 0));
}

/** Read failures that need a person; others are retried. */
export function blockingFailure(code: string): BlockReason | null {
  return code === 'authentication' ||
    code === 'permission_denied' ||
    code === 'unsupported_capability'
    ? code
    : null;
}

export type SyncState =
  'needs_rules' | 'syncing' | 'current' | 'paused' | 'retrying' | 'blocked';

export interface ConnectionState {
  status: 'pending' | 'active' | 'degraded' | 'disconnected' | 'revoked';
  canRead: boolean;
}

const blockedReasons: Record<BlockReason, string> = {
  authentication:
    'The mailbox no longer accepts Luma’s access. Reconnect it in Apps.',
  permission_denied:
    'The mailbox does not allow Luma to read messages. Reconnect it with read access in Apps.',
  unsupported_capability:
    'This connection cannot read messages. Reconnect it with read access in Apps.',
  principal_unavailable:
    'The person Luma reads this mailbox as can no longer read messages. Read the mailbox now to continue as yourself.',
};

const retryReasons: Record<string, string> = {
  rate_limited:
    'The mailbox provider asked Luma to slow down. Luma retries shortly.',
  unavailable:
    'The mailbox provider could not be reached. Luma retries shortly.',
  timeout: 'The mailbox provider did not answer in time. Luma retries shortly.',
};

/** Maps stored mailbox state to what people see, with a reason when reading is held up. */
export function mailboxState(
  mailbox: Pick<
    Mailbox,
    'paused' | 'blocked' | 'attempts' | 'lastError' | 'cursor'
  >,
  rules: readonly Pick<MailboxRule, 'backfilledAt'>[],
  connection: ConnectionState | null,
): { state: SyncState; reason: string | null } {
  if (mailbox.paused) return { state: 'paused', reason: null };
  if (!connection || connection.status === 'disconnected')
    return {
      state: 'blocked',
      reason: 'The mailbox is disconnected. Connect it again in Apps.',
    };
  if (connection.status === 'revoked')
    return {
      state: 'blocked',
      reason:
        'The mailbox provider revoked Luma’s access. Reconnect it in Apps.',
    };
  if (connection.status === 'pending')
    return {
      state: 'blocked',
      reason: 'The mailbox connection is not finished. Complete it in Apps.',
    };
  if (!connection.canRead)
    return { state: 'blocked', reason: blockedReasons.permission_denied };
  if (mailbox.blocked)
    return { state: 'blocked', reason: blockedReasons[mailbox.blocked] };
  if (!rules.length) return { state: 'needs_rules', reason: null };
  if (mailbox.attempts > 0 && mailbox.lastError)
    return {
      state: 'retrying',
      reason:
        retryReasons[mailbox.lastError] ??
        'Reading the mailbox failed. Luma retries shortly.',
    };
  if (
    mailbox.cursor.scan ||
    !mailbox.cursor.coveredUntil ||
    rules.some((rule) => !rule.backfilledAt)
  )
    return { state: 'syncing', reason: null };

  return { state: 'current', reason: null };
}
