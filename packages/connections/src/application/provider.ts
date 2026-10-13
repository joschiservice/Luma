import type { TenantContext } from '@luma/identity';

import type { Observation, ReadCapability } from '../domain/capabilities.js';
import type {
  InstallationCapability,
  InstallationCredentials,
  InstallationInput,
  InstallationTarget,
  InstalledConnection,
} from '../domain/installation.js';
import type { ConnectorConnection } from './capabilities.js';
import type {
  InstallationDependencies,
  InstallationService,
} from './installations.js';

interface ConnectorEvidence {
  tenantId: string;
  connectionId: string;
  apiVersion: string;
  capability: ReadCapability;
  observations: Observation<unknown>[];
  raw?: { payloads: unknown[]; expiresAt: string };
}

export interface ProviderRuntimeOptions {
  installations: InstallationService;
  /** Persists a normalized observation batch before a provider read resolves. */
  recordObservations(evidence: ConnectorEvidence): Promise<void>;
  fetch?: typeof globalThis.fetch;
  /** Applies a caller's read-only total deadline and payload budget to the provider's selected transport. */
  readBounds?: {
    signal: AbortSignal;
    maxRequests: number;
    maxResponseBytes: number;
    maxTotalBytes: number;
  };

  simulation?: (connection: InstalledConnection) => typeof fetch | undefined;
}

/** App-owned connection behavior. The host handles authorization and encrypted storage. */
export interface ConnectionProvider {
  appId: string;
  provider: string;
  targets: readonly string[];
  management?: ('check' | 'rotate')[];
  /** Whether access failures should revoke or degrade current connection grants. */
  recordAccessFailures?: boolean;
  /** Validates app settings and requested capabilities. */
  validate(input: InstallationInput): InstallationInput;
  /** Validates replacement credentials for this target. */
  credentials(
    target: InstallationTarget,
    input: unknown,
  ): InstallationCredentials;
  verify: InstallationDependencies['verify'];
  /** Builds an adapter using freshly authorized credentials. */
  build(
    context: TenantContext,
    id: string,
    capability: InstallationCapability,
    options: ProviderRuntimeOptions,
  ): Promise<ConnectorConnection>;
  /** Refreshes expiring credentials before the host decrypts their current version. */
  refreshCredential?(
    context: TenantContext,
    id: string,
  ): Promise<InstallationCredentials | void>;
  /** Rejects lifecycle operations that require an app-specific flow. */
  manage?(operation: 'install' | 'check' | 'rotate'): void;
}
