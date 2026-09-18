import type { ReadCapability } from './capabilities.js';
export type InstallationTarget =
  | { kind: 'shopify'; shop: string }
  | { kind: 'jtl-cloud'; jtlTenantId: string }
  | { kind: 'jtl-onprem'; baseUrl: string; appId: string; appVersion: string };
export type InstallationCredentials = {
  token: string;
  challengeCode?: string | undefined;
};
export type InstallationInput = {
  label: string;
  target: InstallationTarget;
  permissions: ReadCapability[];
  credentials: InstallationCredentials;
};
export type InstalledConnection = {
  id: string;
  tenantId: string;
  label: string;
  target: InstallationTarget;
  permissions: ReadCapability[];
  granted: ReadCapability[];
  status: 'pending' | 'active' | 'degraded' | 'disconnected' | 'revoked';
  version: number;
  credentialVersion: number;
  createdAt: string;
  updatedAt: string;
};
