import type { ReadCapability } from './capabilities.js';

export type InstallationCapability =
  | ReadCapability
  | 'inventory.available.reconcile'
  | 'orders.shipping-method.write'
  | 'purchase-orders.submit'
  | 'fulfillment.hold.release'
  | 'fulfillment.open'
  | 'fulfillment.move';

/** Public provider settings; each app validates its own fields. */
export type InstallationTarget = { kind: string; [key: string]: string };

/** Encrypted app-owned credentials. Never return this object through public APIs. */
export type InstallationCredentials = { token: string; [key: string]: unknown };

export type InstallationInput = {
  label: string;
  target: InstallationTarget;
  permissions: InstallationCapability[];
  credentials: InstallationCredentials;
};

export type InstalledConnection = {
  /** Null or absent inherits the workspace; an override can only prevent writes. */
  writeMode?: 'observe_only' | null;
  provider?: string;
  appId?: string;
  management?: ('check' | 'rotate')[];
  appInstallationVersion?: number;
  id: string;
  tenantId: string;
  label: string;
  target: InstallationTarget;
  permissions: InstallationCapability[];
  granted: InstallationCapability[];
  status: 'pending' | 'active' | 'degraded' | 'disconnected' | 'revoked';
  version: number;
  credentialVersion: number;
  createdAt: string;
  updatedAt: string;
};
