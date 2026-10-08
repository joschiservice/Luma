export {
  failureMessage,
  historyWindow,
  nextDueAt,
  planScan,
  recordCapabilities,
  recordTypeFor,
  recordTypes,
  retryDelayMs,
  streamStatus,
  syncPolicy,
} from './domain/streams.js';

export type {
  BlockReason,
  RecordType,
  ScanKind,
  ScanPlan,
  ScanTrigger,
  StreamStatus,
  SyncStream,
} from './domain/streams.js';

export { readableKey } from './domain/labels.js';

export { createSyncRunner } from './application/runner.js';

export type {
  SyncRunner,
  SyncRunnerDependencies,
} from './application/runner.js';

export { createSyncService } from './application/service.js';

export type {
  IdentityReader,
  SyncService,
  SyncServiceDependencies,
} from './application/service.js';

export type {
  IdentityDetail,
  LinkInput,
  LinkRequestView,
  SyncConnectionView,
  SyncOverview,
  SyncRunView,
  SyncStreamView,
} from './application/views.js';

export type {
  LedgerEntry,
  LinkRequest,
  PageCommit,
  StreamCommand,
  StreamCoverage,
  SyncConnection,
  SyncRun,
  SyncStore,
} from './application/ports.js';

export {
  createAutoLinkService,
  createAutoLinkRunner,
} from './application/automatic-links.js';

export type { AutoLinkStore } from './application/automatic-links.js';

export type {
  AutoLinkRule,
  AutoLinkPair,
  AutoLinkInput,
  AutoLinkPreview,
} from './domain/automatic-links.js';

export { autoLinkEvidence } from './domain/automatic-links.js';
