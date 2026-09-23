import type { ReadCapability } from './capabilities.js';

export type InstallationCapability =
  ReadCapability | 'orders.shipping-method.write';

export type InstallationTarget =
  | { kind: 'shopify'; shop: string }
  | { kind: 'jtl-cloud'; jtlTenantId: string }
  | { kind: 'jtl-onprem'; baseUrl: string; appId: string; appVersion: string };

export type InstallationCredentials = {
  token: string;
  shopify?:
    | {
        app: string;
        refreshToken: string;
        expiresAt: string;
        refreshExpiresAt: string;
        scopes: string[];
      }
    | undefined;
  challengeCode?: string | undefined;
};

export type InstallationInput = {
  label: string;
  target: InstallationTarget;
  permissions: InstallationCapability[];
  credentials: InstallationCredentials;
};

export type InstalledConnection = {
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
