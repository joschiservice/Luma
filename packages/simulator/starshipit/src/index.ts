import type { ProviderSimulator } from '@luma/simulator-core';

import { command, type StarshipitCommand } from './commands.js';
import { drift, handle, identify, unauthorized } from './http.js';
import type { StarshipitConfig } from './model.js';

export type { StarshipitCommand } from './commands.js';

export type {
  StarshipitConfig,
  StarshipitContext,
  StarshipitOrder,
} from './model.js';

/** Stateful Starshipit protocol used by the unchanged installed adapter in local environments. */
export const starshipit: ProviderSimulator<
  StarshipitConfig,
  StarshipitCommand,
  { id: string }
> = {
  kind: 'starshipit',
  table: 'sim_starshipit_records',
  identify,
  handle,
  command,
  unauthorized,
  drift,
};
