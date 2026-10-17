import type {
  InstallationCapability,
  InstallationDependencies,
} from '@luma/connections';
import { simulationTransport } from '@luma/connections/adapters';
import type { SimulationTransport } from '@luma/connections/composition';
import { canRead, canSend, createClient, fail } from '@luma/connector-gmail';

import {
  gmailReads,
  installationTarget,
  storedCredentials,
} from '../domain/installation-validation.js';

/**
 * Verifies that the token reads the expected mailbox and grants only what the recorded Google
 * scopes allow. Without recorded scopes (token-based fixtures), reading is proven by the profile
 * read, and sending is granted only to simulated connections.
 */
export function createInstallationVerifier(options: {
  fetch?: typeof globalThis.fetch | undefined;
  simulation?: SimulationTransport | undefined;
}): InstallationDependencies['verify'] {
  return async (connection, credentials) => {
    const target = installationTarget.parse(connection.target);
    const stored = storedCredentials.parse(credentials);
    const simulated = simulationTransport(connection, options.simulation);
    const fetch = simulated ?? options.fetch;
    const scopes = stored.gmail?.scopes;
    if (scopes && !canRead(scopes)) return [];
    const client = createClient({
      accessToken: async () => stored.token,
      ...(fetch ? { fetch } : {}),
    });
    const profile = await client.profile();
    if (profile.emailAddress.toLowerCase() !== target.emailAddress)
      fail('permission_denied');
    const granted: InstallationCapability[] = [...gmailReads];
    if (scopes ? canSend(scopes) : !!simulated) granted.push('messages.send');

    return granted;
  };
}
