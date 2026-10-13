import { createHash } from 'node:crypto';

import { canonicalJson } from '@luma/platform';

import { createViewActions } from '../application/actions.js';

/** Composes canonical review fingerprints and stable per-record owner command IDs. */
export function createAdaptiveActions(
  deps: Omit<Parameters<typeof createViewActions>[0], 'digest' | 'commandId'>,
) {
  return createViewActions({
    ...deps,
    digest: (value) =>
      createHash('sha256').update(canonicalJson(value)).digest('hex'),
    commandId: (commandId, recordId) => {
      const hex = createHash('sha256')
        .update(`adaptive-action:${commandId}:${recordId}`)
        .digest('hex');

      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    },
  });
}
