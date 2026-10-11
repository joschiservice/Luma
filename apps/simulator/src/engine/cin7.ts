import { createCin7Simulator } from '@luma/simulator-cin7';
import { jtl, type JtlCommand, kinds } from '@luma/simulator-jtl';

/**
 * A simulated Cin7 Core account that runs the same ERP model as the simulated JTL-Wawi, so the
 * merchant behaves the same with either ERP; only the API Luma reads differs.
 */
export const cin7 = createCin7Simulator({
  kinds,
  command: (context, command: JtlCommand) => jtl.command(context, command),
});
