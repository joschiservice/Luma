import type { AuthorityReader, CapabilityReader } from '@luma/connections';
import type { VerificationEvaluator } from '@luma/exceptions';
import type { IdentityService } from '@luma/identity';
import type { Observability, TenantDatabase } from '@luma/platform';

import { createActiveDiagnosisRereader } from './active-diagnosis.js';
import { createTenantFeatureRelease } from './feature-release.js';
import { createDetectionServices } from './services.js';

/**
 * Composes detection and diagnosis on the shared database. Diagnoses reread stale sources through
 * `reader` only for tenants with the `active-diagnosis` release; without a reader they never
 * reread.
 */
export function createDetectionRuntime(options: {
  database: TenantDatabase;
  identity: IdentityService;
  authority: (db: TenantDatabase) => AuthorityReader;
  reader: CapabilityReader | undefined;
  verifier: VerificationEvaluator | undefined;
  observability: Observability | undefined;
}) {
  const { database, identity, authority } = options;
  const diagnosisRereader = createActiveDiagnosisRereader({
    database,
    authority: authority(database),
    reader: options.reader,
    identity,
    enabled: (tenantId) =>
      createTenantFeatureRelease(options.observability)(
        tenantId,
        'active-diagnosis',
      ),
  });

  return createDetectionServices(
    database,
    undefined,
    options.verifier,
    { ...(diagnosisRereader ? { rereader: diagnosisRereader } : {}) },
    authority(database),
    identity,
  );
}
