export { createSyncRunner } from './application/runner.js';

export { createSyncService } from './application/service.js';

export type { SyncService } from './application/service.js';

/** @public Declaration emit names these in the inferred type of `createCommerceSyncService` in application-runtime. */
export type {
  IdentityDetail,
  LinkInput,
  LinkRequestView,
  SyncOverview,
  SyncStreamView,
} from './application/views.js';

export {
  createAutoLinkService,
  createAutoLinkRunner,
} from './application/automatic-links.js';

/** @public Declaration emit names it in the inferred type of `createAutomaticLinkStore` in application-runtime. */
export type { AutoLinkStore } from './application/automatic-links.js';

/** @public Declaration emit names these in the inferred type of `createCommerceSyncService` in application-runtime. */
export type {
  AutoLinkRule,
  AutoLinkPair,
  AutoLinkInput,
  AutoLinkPreview,
} from './domain/automatic-links.js';

export { autoLinkEvidence } from './domain/automatic-links.js';
