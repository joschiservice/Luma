import type {
  InstallationCredentials,
  InstallationInput,
  InstalledConnection,
} from '@luma/api-contract';

/** Workspace-scoped services supplied to first-party UI contributions. */
export interface AppUiProps {
  organizationId: string;
  /** Setup uses connections; settings receives a connection; app-settings edits workspace-wide options. */
  slot: 'connections' | 'settings' | 'app-settings' | 'page';
  connection?: InstalledConnection | undefined;
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
    /** Produces safe, actionable feedback without exposing provider payloads. */
    error(error: unknown): string;
    /** Returns whether a failed mutation may have reached the server. */
    uncertain(error: unknown): boolean;
  };
}
