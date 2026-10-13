import type {
  BlockReason,
  RecordType,
  ScanKind,
  ScanTrigger,
  StreamStatus,
} from '../domain/streams.js';

/** One record type's sync state as operators see it. */
export interface SyncStreamView {
  id: string;
  status: StreamStatus;
  phase: 'backfill' | 'incremental';
  paused: boolean;
  blocked: BlockReason | null;
  scan: {
    kind: ScanKind;
    startedAt: string;
    since: string | null;
    createdSince?: string | null;
    waitingForExport?: boolean;
    pages: number;
    records: number;
    total: number | null;
  } | null;
  records: {
    total: number;
    current: number;
    pending: number;
    failed: number;
    missing: number;
    retired: number;
  };
  problems: string[];
  coverage: {
    oldest: string | null;
    newest: string | null;
    historyFrom: string | null;
    historyRequirement: string | null;
    olderHistoryAvailable: boolean;
    recentFrom?: string | null;
    recentCompletedAt?: string | null;
  };
  lastSuccessAt: string | null;
  lastCompleteAt: string | null;
  lastFullScanAt: string | null;
  backfillStartedAt: string | null;
  backfillCompletedAt: string | null;
  nextRunAt: string | null;
  error: { code: string; message: string; at: string; attempts: number } | null;
}

export interface SyncConnectionView {
  connectionId: string;
  label: string;
  provider: string;
  appId: string | null;
  status: 'pending' | 'active' | 'degraded' | 'disconnected' | 'revoked';
  recordTypes: {
    recordType: RecordType;
    availability: 'granted' | 'not_granted' | 'not_requested';
    stream: SyncStreamView | null;
  }[];
}

interface SyncRunView {
  id: string;
  connectionId: string;
  recordType: RecordType;
  kind: ScanKind;
  trigger: ScanTrigger;
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

export interface SyncOverview {
  connections: SyncConnectionView[];
  runs: SyncRunView[];
  canManage: boolean;
  asOf: string;
}

export interface IdentitySource {
  connectionId: string;
  connectionLabel: string;
  provider: string;
  externalId: string;
  scopeKey: string;
  method: string;
  linkedAt: string;
  revisedAt: string | null;
  /** Order facts help a person review a match; missing fields remain unknown. */
  order?: {
    number: string | null;
    externalNumber: string | null;
    placedAt: string | null;
    total: { amount: string; currency: string } | null;
  };
  codes: string[];
  titles: string[];
}

export interface LinkRequestView {
  id: string;
  kind: 'sku' | 'location' | 'order' | 'order_line';
  operation: 'link' | 'unlink';
  entityId: string;
  otherId: string | null;
  connectionId: string | null;
  reason: string;
  state: 'requested' | 'running' | 'completed' | 'failed';
  message: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface IdentityDetail {
  entity: {
    id: string;
    kind: 'sku' | 'location' | 'order' | 'order_line';
    label: string;
    orderId?: string;
    unit?: string;
  };
  sources: IdentitySource[];
  suggestions: {
    id: string;
    label: string;
    reason: string;
    sources: IdentitySource[];
  }[];
  requests: LinkRequestView[];
  canManage: boolean;
}

export type LinkInput =
  | {
      operation: 'link';
      kind: 'sku' | 'location' | 'order' | 'order_line';
      entityId: string;
      otherId: string;
      reason: string;
    }
  | {
      operation: 'unlink';
      kind: 'sku' | 'location' | 'order' | 'order_line';
      entityId: string;
      connectionId: string;
      reason: string;
    };
