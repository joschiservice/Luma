import type { HistoryLimit, SourceIdentity } from '@luma/connections';

import type {
  BlockReason,
  RecordType,
  ScanKind,
  ScanPlan,
  SyncStream,
} from '../domain/streams.js';

/** A connection as the sync worker needs it: state, granted reads and who installed it. */
export interface SyncConnection {
  id: string;
  label: string;
  provider: string;
  status: 'pending' | 'active' | 'degraded' | 'disconnected' | 'revoked';
  granted: string[];
  /** The person who first installed or authorized the connection, when recorded. */
  installerId: string | null;
}

export type ItemKey = Pick<
  SourceIdentity,
  'resource' | 'scopeKey' | 'externalId'
>;

/** Ledger key for one source record within a stream. */
export const itemKey = (item: ItemKey) =>
  JSON.stringify([item.resource, item.scopeKey, item.externalId]);

interface LedgerState {
  digest: string;
  status: 'current' | 'pending' | 'failed';
}

/** One source record's import result, written with the page checkpoint. */
export interface LedgerEntry extends ItemKey {
  digest: string;
  status: 'current' | 'pending' | 'failed';
  problem: string | null;
  entityId: string | null;
  sourceCreatedAt: string | null;
  sourceUpdatedAt: string | null;
}

export interface PageCounts {
  records: number;
  changed: number;
  unchanged: number;
  pending: number;
  failed: number;
}

/** Everything a successful page commits atomically with its checkpoint. */
interface PageCommit {
  /** Records imported or re-imported from this page. */
  entries: LedgerEntry[];
  /** Records whose stored digest matched; only their last-seen scan is updated. */
  unchanged: ItemKey[];
  counts: PageCounts;
  nextCursor: string | null;
  total: number | null;
  /** History limit reported by the page; undefined when the page did not say. */
  history: HistoryLimit | null | undefined;
  /** Set on the last page; finishes the scan and schedules the next one. */
  complete: { nextDueAt: string } | null;
  now: string;
  /** Provider export is still preparing; keep its checkpoint without claiming coverage. */
  deferred?: boolean;
  dueAt?: string;
  /** Ledger entries to delete when they are still flagged missing. */
  forget?: ItemKey[];
}

export interface SyncRun {
  id: string;
  streamId: string;
  connectionId: string;
  recordType: RecordType;
  kind: ScanKind;
  trigger: ScanPlan['trigger'];
  since: string | null;
  /** Creation window of a recent-history run; null for other runs. */
  createdSince?: string | null;
  fullScan: boolean;
  startedAt: string;
  finishedAt: string | null;
  outcome: 'running' | 'completed' | 'cancelled';
  pages: number;
  records: number;
  changed: number;
  unchanged: number;
  pending: number;
  failed: number;
  missing: number | null;
  errors: number;
}

export interface StreamCoverage {
  streamId: string;
  total: number;
  current: number;
  pending: number;
  failed: number;
  missing: number;
  oldest: string | null;
  newest: string | null;
  /** Up to five controlled explanations of records that could not be imported. */
  problems: string[];
}

export type StreamCommand =
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'retry' }
  | { kind: 'reconcile' }
  | { kind: 'reimport' };

export interface LinkRequest {
  id: string;
  kind: 'sku' | 'location' | 'order';
  operation: 'link' | 'unlink';
  entityId: string;
  otherId: string | null;
  connectionId: string | null;
  reason: string;
  requestedBy: string;
  state: 'requested' | 'running' | 'completed' | 'failed';
  message: string | null;
  createdAt: string;
  completedAt: string | null;
}

/** Tenant-scoped persistence for streams, the import ledger and link requests. */
export interface SyncStore {
  /** Tenants with work: due, hinted or unstarted streams and pending link requests. */
  scopes(): Promise<string[]>;
  connections(tenantId: string): Promise<SyncConnection[]>;
  streams(tenantId: string): Promise<SyncStream[]>;
  /** Creates missing streams; existing streams for these record types are unchanged. */
  createStreams(
    tenantId: string,
    connectionId: string,
    recordTypes: RecordType[],
    principalId: string,
  ): Promise<void>;
  /** Blocks or unblocks streams; blocking cancels any lease. */
  setBlocked(
    tenantId: string,
    streamIds: string[],
    reason: BlockReason | null,
  ): Promise<void>;
  /** Moves unconsumed change notifications onto matching streams as hints. */
  applyHints(tenantId: string, delayMs: number): Promise<number>;
  /** Leases the next due stream, or returns null. */
  claim(
    tenantId: string,
    token: string,
    leaseMs: number,
    options?: {
      connectionId?: string;
      connectionConcurrency?: number;
      workspaceConcurrency?: number;
    },
  ): Promise<SyncStream | null>;
  /** Saves a history checkpoint before a live scan, within the current lease. */
  suspendScan(
    tenantId: string,
    streamId: string,
    token: string,
  ): Promise<SyncStream | null>;
  /** Defers all streams sharing a connection's provider budget. */
  deferConnection(
    tenantId: string,
    connectionId: string,
    dueAt: string,
  ): Promise<void>;
  startScan(
    tenantId: string,
    streamId: string,
    token: string,
    run: {
      id: string;
      plan: ScanPlan;
      fullScan: boolean;
      now: string;
      liveEnabled?: boolean;
    },
  ): Promise<SyncStream | null>;
  ledger(
    tenantId: string,
    connectionId: string,
    recordType: RecordType,
    keys: ItemKey[],
  ): Promise<Map<string, LedgerState>>;
  /**
   * Records that complete full reads have not found since before `before`, oldest first, up to
   * `limit`.
   */
  missingSince(
    tenantId: string,
    connectionId: string,
    recordType: RecordType,
    before: string,
    limit: number,
  ): Promise<ItemKey[]>;
  /** Commits one page; returns false when the lease was lost and nothing was written. */
  commitPage(
    tenantId: string,
    streamId: string,
    token: string,
    page: PageCommit,
  ): Promise<boolean>;
  /** Records a failed page and releases the lease; `restart` discards the scan cursor. */
  failPage(
    tenantId: string,
    streamId: string,
    token: string,
    failure: {
      code: string;
      message: string;
      dueAt: string;
      restart: boolean;
      block: BlockReason | null;
    },
  ): Promise<void>;
  overview(tenantId: string): Promise<{
    streams: SyncStream[];
    coverage: StreamCoverage[];
    runs: SyncRun[];
  }>;
  /**
   * Applies an idempotent operator command. Commands that continue work make `principalId`
   * the person the stream runs as. Returns false when the stream does not exist.
   */
  command(
    tenantId: string,
    streamId: string,
    command: StreamCommand,
    principalId: string,
  ): Promise<boolean>;
  requestLink(
    tenantId: string,
    request: Omit<
      LinkRequest,
      'state' | 'message' | 'createdAt' | 'completedAt'
    >,
  ): Promise<LinkRequest>;
  linkRequests(tenantId: string, entityId: string): Promise<LinkRequest[]>;
  linkRequest(tenantId: string, id: string): Promise<LinkRequest | null>;
  claimLink(tenantId: string, leaseMs: number): Promise<LinkRequest | null>;
  finishLink(
    tenantId: string,
    id: string,
    result: {
      state: 'completed' | 'failed' | 'requested';
      message: string | null;
    },
  ): Promise<void>;
}
