import { type Configuration, defaultConfiguration } from './facts.js';

/** Detection settings a workspace saved; omitted stall thresholds keep their defaults. */
export interface WorkspaceDetectionSettings {
  inventoryTolerance: string;
  propagationSeconds: number;
  oversellPropagationSeconds: number;
  stuckSeconds: number;
  stallSeconds?: number | undefined;
  stallMinPositions?: number | undefined;
  stallSharePercent?: number | undefined;
}

/**
 * Applies a workspace's saved detection settings to the default configuration. Returns null when
 * they change nothing, so the default configuration and its version stay in use. Otherwise the
 * version is the default version plus the first 16 characters of `digest` over the effective
 * configuration, so evidence records which thresholds judged it.
 */
export function workspaceDetectionConfiguration(
  settings: WorkspaceDetectionSettings,
  digest: (value: string) => string,
): Configuration | null {
  const { inventoryTolerance, ...thresholds } = settings;
  const configuration = {
    ...defaultConfiguration,
    inventoryTolerance,
    thresholds: { ...defaultConfiguration.thresholds, ...thresholds },
  };
  if (JSON.stringify(configuration) === JSON.stringify(defaultConfiguration))
    return null;
  configuration.version = `${defaultConfiguration.version}:${digest(JSON.stringify(configuration)).slice(0, 16)}`;

  return configuration;
}
