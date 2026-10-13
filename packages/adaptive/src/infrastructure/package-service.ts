import { createHash } from 'node:crypto';

import { canonicalJson } from '@luma/platform';

import { createOperationalPackages } from '../application/packages.js';
import { parsePackageConfiguration } from './packages.js';

/** Composes validated parameters and stable package-review fingerprints. */
export function createAdaptivePackages(
  deps: Omit<
    Parameters<typeof createOperationalPackages>[0],
    'parseConfig' | 'digest'
  >,
) {
  return createOperationalPackages({
    ...deps,
    parseConfig: parsePackageConfiguration,
    digest: (value) =>
      createHash('sha256').update(canonicalJson(value)).digest('hex'),
  });
}
