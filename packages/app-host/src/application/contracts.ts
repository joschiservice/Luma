import type {
  ConnectionProvider,
  InstalledConnection,
  SecretCipher,
} from '@luma/connections';
import type { IdentityService, TenantContext } from '@luma/identity';
import type { SqlTransaction, TenantDatabase } from '@luma/platform';
import type { CaseWorkflowAdapter } from '@luma/workflows';
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
    | 'inventory'
    | 'customers'
    | 'fulfillment'
  )[];
  connectionTypes: { kind: string; name: string }[];
}

export type { WorkspaceApp } from '../domain/installation.js';

/**
 * A decision an app-owned service is waiting on a person for. The host lists it in Needs you;
 * responses still go through the app's own review, which checks the exact proposal again.
 */
export interface AppDecision {
  /**
   * Stable and app-prefixed, such as `shopify:inventory_correction:<target>`. Keep it while the
   * same problem waits on a person, so a refreshed proposal updates the item in place.
   */
  id: string;
  kind: 'fulfillment_recovery' | 'inventory_correction';
  reason: 'approval' | 'run' | 'recovery';
  domain: 'orders' | 'fulfillment' | 'inventory';
  title: string;
  /** Why a person is needed. */
  why: string;
  /** What each response available to the reader causes. */
  consequences: { response: string; text: string }[];
  /** The exact proposed change: source, target, location and quantities. */
  change: { label: string; value: string }[];
  /** Business impact; `unknown` unless the app has an explicit rule for it. */
  impact: { level: 'high' | 'medium' | 'low' | 'unknown'; text: string | null };
  requestedAt: string;
  /** When the proposal loses its authority; null when nothing expires. */
  deadline: string | null;
  requesterId: string | null;
  evidence: { observedAt: string | null; validUntil: string | null };
  response: 'decide' | 'run' | 'check' | 'awaiting_other' | 'view_only';
  subject: { label: string; detail: string | null };
  /** The affected record by canonical ID or by its source identity. */
  record:
    | { kind: 'position' | 'order' | 'fulfillment'; id: string }
    | {
        kind: 'order' | 'fulfillment';
        source: { connectionId: string; externalId: string };
      }
    | null;
  /** The app UI slot and target whose review owns the decision. */
  owner:
    | {
        kind: 'app_fulfillment';
        connectionId: string;
        orderId: string;
        fulfillmentId: string;
      }
    | { kind: 'app_inventory'; positionId: string };
  group: { key: string; label: string };
}

export interface AppDefinition {
  manifest: AppManifest;
  connector?: ConnectionProvider;
  /**
   * Lists the tenant's decisions this app waits on a person for, from persisted state only.
   * Must check workspace installation and roles; return an empty list when the reader can't
   * see them. Do not perform provider reads.
   */
  decisions?(context: TenantContext): Promise<AppDecision[]>;
  /**
   * Built-in workflows that start for new cases. Each must send changes through the app's
   * governed proposal, approval, admission and verification path.
   */
  workflows?: CaseWorkflowAdapter[];
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
  /** Routes synthetic connections through their trusted simulator binding. */
  simulation?: (connection: InstalledConnection) => typeof fetch | undefined;
  env: Readonly<Record<string, string | undefined>>;
  /**
   * Rereads a stock position's stale sources through installed capabilities and stores them as
   * current, so an app can act on fresh stock. Absent where the host has no capability runtime.
   */
  refreshStock?(context: TenantContext, positionId: string): Promise<void>;
}

/** Builds deployment contributions using explicit host services and environment configuration. */
export type AppFactory = (context: AppFactoryContext) => AppDefinition;

export interface AppLifecycleContext {
  tenantId: string;
  actorId: string;
  version: number;
  transaction: SqlTransaction;
}
