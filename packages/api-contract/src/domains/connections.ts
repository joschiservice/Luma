import { sourceAuthorityContract } from '../contracts/authority.js';
import { connectionsContract } from '../contracts/connections.js';
import { connectorProvidersContract } from '../contracts/providers.js';
import { sourceEnvironmentsContract } from '../contracts/source-environments.js';

/** Routes served by `@luma/connections`. */
type ConnectionsContracts = {
  connections: typeof connectionsContract;
  connectorProviders: typeof connectorProvidersContract;
  sourceAuthority: typeof sourceAuthorityContract;
  sourceEnvironments: typeof sourceEnvironmentsContract;
};

/** Routes served by `@luma/connections`, keyed by area. */
export const connectionsContracts: ConnectionsContracts = {
  connections: connectionsContract,
  connectorProviders: connectorProvidersContract,
  sourceAuthority: sourceAuthorityContract,
  sourceEnvironments: sourceEnvironmentsContract,
};
