import type { ConnectionProvider, SecretCipher } from '@luma/connections';
import type { IdentityService, TenantContext } from '@luma/identity';
import type { SqlTransaction, TenantDatabase } from '@luma/platform';
import type { FastifyInstance } from 'fastify';

export interface AppManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  category: 'storefront' | 'erp' | 'utility';
  ui: (
    | 'connections'
    | 'settings'
    | 'app-settings'
    | 'page'
    | 'record'
    | 'customers'
  )[];
  connectionTypes: { kind: string; name: string }[];
}

export type { WorkspaceApp } from '../domain/installation.js';

export interface AppDefinition {
  manifest: AppManifest;
  connector?: ConnectionProvider;
  /** Registers app-owned HTTP handlers; handlers must check workspace installation. */
  registerHttp?(server: FastifyInstance, identity?: IdentityService): void;
  /** Updates app-owned storage inside the installation transaction. Do not perform network requests. */
  installed?(context: AppLifecycleContext): Promise<void>;
  /** Cleans up app-owned storage inside the uninstall transaction. Historical records should be retained. */
  uninstalled?(context: AppLifecycleContext): Promise<void>;
  /** Checks deployment resources owned by this app. */
  ready?(): Promise<boolean>;
}

export interface AppFactoryContext {
  database: TenantDatabase;
  cipher: SecretCipher;
  /** Refreshes membership before authorizing an app operation. */
  refreshContext(context: TenantContext): Promise<TenantContext>;
  /** Rejects calls for uninstalled or unavailable apps. */
  requireInstalled(context: TenantContext, appId: string): Promise<number>;
  env: Readonly<Record<string, string | undefined>>;
}

/** Builds deployment contributions using explicit host services and environment configuration. */
export type AppFactory = (context: AppFactoryContext) => AppDefinition;

export interface AppLifecycleContext {
  tenantId: string;
  actorId: string;
  version: number;
  transaction: SqlTransaction;
}
