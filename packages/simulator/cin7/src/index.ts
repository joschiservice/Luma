import type { ProviderSimulator } from '@luma/simulator-core';

import {
  createHandler,
  drift,
  identify,
  rateLimit,
  unauthorized,
} from './http.js';
import type { Cin7Config, ErpModel } from './model.js';

export {
  allocation,
  availableAt,
  type Cin7Config,
  type Cin7Context,
  type ErpCustomer,
  type ErpItem,
  type ErpModel,
  type ErpNote,
  type ErpOrder,
  type ErpPurchaseOrder,
  type ErpSupplier,
  guid,
  recordOf,
  simulatedAccountId,
} from './model.js';

/**
 * Creates a simulated Cin7 Core account over a host's ERP model: the model applies merchant,
 * warehouse and supplier commands and stores the records; the account answers through Cin7's
 * API v2.
 */
export function createCin7Simulator<Command, Result>(
  model: ErpModel<Command, Result>,
): ProviderSimulator<Cin7Config, Command, Result> {
  return {
    kind: 'cin7',
    table: 'sim_cin7_records',
    identify,
    handle: createHandler(model.kinds),
    command: (context, command) => model.command(context, command),
    unauthorized,
    drift,
    rateLimit,
  };
}
