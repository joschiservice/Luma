import type { TenantContext } from '@luma/identity';

import type { ProcessStep } from '../domain/process.js';
import type { VocabularyContribution } from '../domain/vocabulary.js';
import type { createProcessActivities } from './process-activities.js';
import type { ProcessActivities } from './process-runtime.js';

/** A business owner exposes supported steps and the same admission boundary as other workflow actions. */
export interface CodeProcessBusinessAdapter {
  supports(step: ProcessStep): boolean;
  vocabulary(context: TenantContext): Promise<VocabularyContribution>;
  admission: Parameters<typeof createProcessActivities>[0]['admission'];
  bindAction: Parameters<typeof createProcessActivities>[0]['bindAction'];
  read: ProcessActivities['read'];
  decision: ProcessActivities['decision'];
  verify: ProcessActivities['verify'];
}
