import type {
  AuthorityReader,
  ConnectionProvider,
  InstalledConnection,
  SecretCipher,
} from '@luma/connections';
import type { IdentityService, TenantContext } from '@luma/identity';
import type { SqlTransaction, TenantDatabase } from '@luma/platform';
import type { CaseWorkflowAdapter } from '@luma/workflows';
import type { FastifyInstance } from 'fastify';

export type AppSlot =
  | 'connections'
  | 'settings'
  | 'app-settings'
  | 'page'
  | 'record'
  | 'inventory'
  | 'fulfillment';

/** A permission an app owns. People who can manage roles grant it like a core permission. */
export interface AppPermissionDeclaration {
  /** Namespaced as `<appId>:<name>`, for example `shopify:fulfillment_recovery.run`. */
  key: string;
  label: string;
  description: string;
  /** Grants changes to provider data, money or access. */
  consequential: boolean;
}

/**
 * Plain data describing an app. Permission and access fields are validated when the app
 * registers, so the same contract can describe apps that are not compiled into Luma.
 */
export interface AppManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  category: 'storefront' | 'erp' | 'utility';
  ui: AppSlot[];
  connectionTypes: { kind: string; name: string }[];
  /** Permissions this app owns. */
  permissions: AppPermissionDeclaration[];
  /**
   * Core permissions the app needs to read or act in a workspace. Installing grants them;
   * when the app acts for a person it is limited to scopes both the app and the person hold.
   */
  scopes: string[];
  /** The permission a person needs to see each slot in `ui`: a core or this app's permission. */
  slotAccess: Partial<Record<AppSlot, string>>;
  /** Permissions to see, and to respond to, each kind of decision the app lists in Needs you. */
  decisionAccess?: Partial<
    Record<AppDecision['kind'], { view: string; respond: string }>
  >;
}

export type { WorkspaceApp } from '../domain/installation.js';

/**
 * A decision an app-owned service is waiting on a person for. The host lists it in Needs you;
 * responses still go through the app's own review, which checks the exact proposal again.
 */
export interface AppDecision {
  /** Writes are withheld by workspace or connection owner controls. */
  observeOnly?: boolean;
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
   * The host calls it only for installed apps and filters items by `manifest.decisionAccess`.
   * Do not perform provider reads.
   */
  decisions?(context: TenantContext): Promise<AppDecision[]>;
  /**
   * Built-in workflows that start for new cases. Each must send changes through the app's
   * governed proposal, approval, admission and verification path.
   */
  workflows?: CaseWorkflowAdapter[];
  /**
   * Registers app-owned HTTP handlers. Each tenant route declares `config.access`; the host
   * checks installation and that permission before the handler runs.
   */
  registerHttp?(server: FastifyInstance, identity?: IdentityService): void;
  /** Updates app-owned storage inside the installation transaction. Do not perform network requests. */
  installed?(context: AppLifecycleContext): Promise<void>;
  /** Cleans up app-owned storage inside the uninstall transaction. Historical records should be retained. */
  uninstalled?(context: AppLifecycleContext): Promise<void>;
  /** Checks deployment resources owned by this app. */
  ready?(): Promise<boolean>;
}

/**
 * An app operation performed for a person. `permission` is the app's own permission, or a core
 * permission for host-level work such as connecting; without one only installation and scopes
 * are checked. `scopes` are the core permissions the operation uses, which both the app
 * installation and the person must hold.
 */
export interface AppOperation {
  app: string;
  permission?: string;
  scopes?: readonly string[];
}

export interface AppFactoryContext {
  database: TenantDatabase;
  /** Shared workspace source authority; absent hosts must withhold authority-dependent writes. */
  sourceAuthority?: AuthorityReader;
  cipher: SecretCipher;
  /** Refreshes membership before authorizing an app operation. */
  refreshContext(context: TenantContext): Promise<TenantContext>;
  /** Rejects calls for uninstalled or unavailable apps. */
  requireInstalled(context: TenantContext, appId: string): Promise<number>;
  /**
   * Requires the app to be installed and available, the person to hold the operation's
   * permission, and every listed scope to be granted to the app and held by the person.
   * Throws 403 naming what is missing. Pass a refreshed context.
   */
  requirePermission(
    context: TenantContext,
    operation: AppOperation,
  ): Promise<void>;
  /** Reports whether `requirePermission` would allow the operation. */
  hasPermission(
    context: TenantContext,
    operation: AppOperation,
  ): Promise<boolean>;
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
