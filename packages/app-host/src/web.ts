import type {
  InstallationCredentials,
  InstallationInput,
  InstalledConnection,
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
    | 'fulfillment';
  /** The source fulfillment and order whose actions the host is showing, by source ID. */
  fulfillment?:
    | { connectionId: string; orderId: string; fulfillmentId: string }
    | undefined;
  /** Canonical stock position whose provider corrections the host is showing. */
  inventory?: { positionId: string } | undefined;
  connection?: InstalledConnection | undefined;
  /** The source record the host is showing, identified by its connection and source ID. */
  record?:
    | {
        kind: 'order';
        connectionId: string;
        externalId: string;
        /**
         * A change the host asks the app to prefill for review, such as a planned quantity
         * edit, by source line ID. The app still previews, checks and asks for approval as
         * usual, and ignores lines it doesn't recognize.
         */
        change?:
          { lines: { externalId: string; quantity: string }[] } | undefined;
      }
    | undefined;
  /** Closes setup and refreshes workspace data after a successful mutation. */
  done(): Promise<void>;
  /**
   * Reports whether the person holds a core or app permission, to hide actions they can't take.
   * The host enforces permissions again on every app request.
   */
  can(permission: string): boolean;
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
    /** Produces safe, actionable feedback without exposing provider payloads. */
    error(error: unknown): string;
    /** Returns whether a failed mutation may have reached the server. */
    uncertain(error: unknown): boolean;
  };
}
