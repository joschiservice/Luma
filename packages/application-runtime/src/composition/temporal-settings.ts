import { createKmsDataKeyService } from '@luma/platform/composition';
import type { TemporalSettings } from '@luma/workflow-temporal';

/** Wires the regional KMS transport outside deterministic workflow code. */
export function createRegionalTemporalSettings<T extends TemporalSettings>(
  settings: T,
): T & Pick<TemporalSettings, 'payloadKeyService'> {
  if (!settings.payloadEncryption || settings.payloadKeyService)
    return settings;

  return {
    ...settings,
    payloadKeyService: createKmsDataKeyService(settings.payloadEncryption, {
      region: settings.dataRegion,
      namespace: settings.namespace,
    }),
  };
}
