import type {
  InstallationCredentials,
  InstallationInput,
  InstalledConnection,
  OrderDetail,
} from '@luma/api-contract';

/** Workspace-scoped services supplied to first-party UI contributions. */
export interface AppUiProps {
  organizationId: string;
  /**
   * Setup uses connections; settings receives a connection; app-settings edits workspace-wide
   * options; page is the app's own page; record shows live source context for `record`;
   * fulfillment offers source actions for `fulfillment`.
   */
  slot:
    | 'connections'
    | 'settings'
    | 'app-settings'
    | 'page'
    | 'record'
    | 'inventory'
    | 'customers'
    | 'fulfillment';
  /** The source fulfillment and order whose actions the host is showing, by source ID. */
  fulfillment?:
    | { connectionId: string; orderId: string; fulfillmentId: string }
    | undefined;
  /** Canonical stock position whose provider corrections the host is showing. */
  inventory?: { positionId: string } | undefined;
  connection?: InstalledConnection | undefined;
  /** Opens a source customer without inferring identity from contact fields. */
  customer?:
    { connectionId?: string | undefined; id?: string | undefined } | undefined;
  /** The source record the host is showing, identified by its connection and source ID. */
  record?:
    { kind: 'order'; connectionId: string; externalId: string } | undefined;
  /** Closes setup and refreshes workspace data after a successful mutation. */
  done(): Promise<void>;
  services: {
    /** Creates a pending connection after server-side app validation. */
    install(input: InstallationInput): Promise<InstalledConnection>;
    /** Replaces credentials at the connection version supplied by the host. */
    rotate(
      connection: InstalledConnection,
      credentials: InstallationCredentials,
    ): Promise<InstalledConnection>;
    /** Sends an authenticated request within this app's workspace namespace. */
    request(path: string, body: unknown): Promise<unknown>;
    /** Resolves an exact source order to its canonical context; ambiguous matches stay explicit. */
    orderContext?(
      connectionId: string,
      externalId: string,
    ): Promise<{
      status: 'matched' | 'unmapped' | 'ambiguous';
      order: OrderDetail | null;
    }>;
    /** Produces safe, actionable feedback without exposing provider payloads. */
    error(error: unknown): string;
    /** Returns whether a failed mutation may have reached the server. */
    uncertain(error: unknown): boolean;
  };
}
