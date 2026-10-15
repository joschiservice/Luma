import type { OrderChangePlans } from '@luma/api-contract';
import type {
  AuthorityReader,
  ConnectionProvider,
  InstalledConnection,
  SecretCipher,
} from '@luma/connections';
import type { IdentityService, TenantContext } from '@luma/identity';
import type {
  AtomicStore,
  SqlTransaction,
  TenantDatabase,
} from '@luma/platform';
import type { CaseWorkflowAdapter } from '@luma/workflows';
import type { FastifyInstance } from 'fastify';

type AppSlot =
  | 'connections'
  | 'settings'
  | 'app-settings'
  | 'page'
  | 'record'
  | 'inventory'
  | 'fulfillment';

/** A permission an app owns. People who can manage roles grant it like a core permission. */
interface AppPermissionDeclaration {
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
  category: 'storefront' | 'erp' | 'communication' | 'utility';
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
  /**
   * The permission a person needs to request each provider write capability through this app,
   * keyed by installation capability such as `orders.quantity.edit`. Plans use it to say who may
   * start a Luma step; the app's own routes still check the permission.
   */
  actionAccess?: Partial<Record<string, string>>;
}

export type { WorkspaceApp } from '../domain/installation.js';

/**
 * A decision an app-owned service is waiting on a person for. The host lists it in Needs you;
 * responses still go through the app's own review, which checks the exact proposal again.
 */
export interface AppDecision {
  /** A trusted workflow will continue this action after approval. */
  automatic?: boolean | undefined;
  /** Bound proposal reference for the shared action diff; it never grants execution. */
  actionReference?: { proposalId: string };
  /** Writes are withheld by workspace or connection owner controls. */
  observeOnly?: boolean;
  /**
   * Stable and app-prefixed, such as `shopify:inventory_correction:<target>`. Keep it while the
   * same problem waits on a person, so a refreshed proposal updates the item in place.
   */
  id: string;
  kind:
    | 'shipment_publication'
    | 'fulfillment_recovery'
    | 'inventory_correction'
    | 'order_edit';
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
    | { kind: 'app_inventory'; positionId: string }
    | { kind: 'app_order'; connectionId: string; orderId: string };
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
  /** Region-local provider admission storage. It is unavailable when deployment configuration is missing. */
  requestBudgetStore?: AtomicStore;
  /** Server-side release checks for a trusted tenant; absent checks withhold unreleased features. */
  featureEnabled?(
    tenantId: string,
    flag:
      | 'scoped-autonomy'
      | 'supplier-purchasing-terms'
      | 'purchasing-stock-booking'
      | 'purchasing-order-changes'
      | 'starshipit-fulfillment'
      | 'starshipit-actions'
      | 'shopify-shipment-publishing',
  ): Promise<boolean>;
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
  /** Lists actual downstream shipment references for a Shopify order; choosing one never implies dispatch eligibility. */
  shipmentDispatchOptions?(
    context: TenantContext,
    input: { connectionId: string; orderId: string },
  ): Promise<
    { downstreamConnectionId: string; shipmentId: string; label: string }[]
  >;
  /** Reads a fresh physical dispatch with exact canonical-to-Shopify line and warehouse mappings. Missing or ambiguous allocation returns null. */
  shipmentDispatchEvidence?(
    context: TenantContext,
    input: {
      connectionId: string;
      orderId: string;
      downstreamConnectionId: string;
      shipmentId: string;
    },
  ): Promise<ShipmentDispatchEvidence | null>;
  /**
   * Another connection's current quantities for the lines of a source order, from Luma's stored
   * reads: the order linked to `orderId` on `connectionId`, and each of its lines by source line
   * ID, matched to `sourceConnectionId` by shared canonical line ID or unambiguous mapped SKU.
   * `quantity` is null when that source doesn't report the line's current units. Returns null
   * when the order isn't linked to both connections or the reader can't read orders. Absent
   * where the host has no order read model; apps must then treat the values as unknown.
   */
  sourceOrderLines?(
    context: TenantContext,
    input: {
      connectionId: string;
      orderId: string;
      sourceConnectionId: string;
    },
  ): Promise<SourceOrderLines | null>;
  /**
   * Rereads every source of a canonical order whose stored read is older than `maxAgeMs` (a
   * minute by default): the order and its fulfilment records, through the installed
   * capabilities' point reads, stored as the sources' current reads. Unshipped work a complete
   * reread no longer returns is retired. Sources that can't be reread keep their stored reads,
   * so plans then report them as stale. Absent where the host has no capability runtime.
   */
  refreshOrder?(
    context: TenantContext,
    orderId: string,
    maxAgeMs?: number,
  ): Promise<void>;
  /**
   * A canonical order's change plans as Orders shows them, from Luma's stored reads: a proposed
   * quantity for one line, or every change the source comparison detected when `request` is null.
   * Requires `orders.read`; null when the order has no current source. Rejects a line that is not
   * on the order with 422. Absent where the host has no order read model.
   */
  orderChangePlans?(
    context: TenantContext,
    orderId: string,
    request: { kind: 'quantity'; lineKey: string; quantity: string } | null,
  ): Promise<OrderChangePlans | null>;
}

/** A source's stored read of an order's line quantities; see `sourceOrderLines`. */
interface SourceOrderLines {
  /** The canonical order both sources report. */
  orderId: string;
  connectionId: string;
  snapshotId: string;
  observationId: string;
  /** When Luma read the source order, on Luma's clock. */
  observedAt: string;
  /** False when current collection evidence or a newer exact order refresh is incomplete. */
  complete: boolean;
  lines: { externalId: string; quantity: string | null }[];
}

/** Builds deployment contributions using explicit host services and environment configuration. */
export type AppFactory = (context: AppFactoryContext) => AppDefinition;

export interface AppLifecycleContext {
  tenantId: string;
  actorId: string;
  version: number;
  transaction: SqlTransaction;
}

/** Allowlisted evidence for publishing a physical dispatch; labels alone never qualify. */
interface ShipmentDispatchEvidence {
  id: string;
  observationId: string;
  observedAt: string;
  revision: string;
  complete: boolean;
  connectionId: string;
  shipmentId: string;
  stage: 'carrier' | 'delivered' | 'unknown';
  locationId: string | null;
  lines: { orderLineId: string; quantity: number }[];
  tracking: { company: string | null; number: string; url: string | null }[];
}
