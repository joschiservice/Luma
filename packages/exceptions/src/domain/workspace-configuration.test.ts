import { describe, expect, it } from 'vitest';

import { defaultConfiguration } from './facts.js';
import { workspaceDetectionConfiguration } from './workspace-configuration.js';

const digest = () => '0123456789abcdef-rest';
const defaults = {
  inventoryTolerance: defaultConfiguration.inventoryTolerance,
  propagationSeconds: defaultConfiguration.thresholds.propagationSeconds,
  oversellPropagationSeconds: 120,
  stuckSeconds: defaultConfiguration.thresholds.stuckSeconds,
};

describe('workspaceDetectionConfiguration', () => {
  it('keeps the default configuration when settings change nothing', () => {
    expect(workspaceDetectionConfiguration(defaults, digest)).toBeNull();
  });

  it('applies changed thresholds under a derived version', () => {
    const configuration = workspaceDetectionConfiguration(
      { ...defaults, inventoryTolerance: '2', stallMinPositions: 5 },
      digest,
    );

    expect(configuration).toMatchObject({
      version: `${defaultConfiguration.version}:0123456789abcdef`,
      inventoryTolerance: '2',
      thresholds: {
        ...defaultConfiguration.thresholds,
        stallMinPositions: 5,
      },
    });
  });
});
