import {
  createCin7Simulator,
  type ErpCustomer,
  type ErpItem,
  type ErpNote,
  type ErpOrder,
  type ErpPurchaseOrder,
  type ErpSupplier,
} from '@luma/simulator-cin7';
import {
  type CustomerRecord,
  type ItemRecord,
  jtl,
  type JtlCommand,
  kinds,
  type NoteRecord,
  type OrderRecord,
  type PurchaseOrderRecord,
  type SupplierRecord,
} from '@luma/simulator-jtl';

/**
 * A simulated Cin7 Core account that runs the same ERP model as the simulated JTL-Wawi, so the
 * merchant behaves the same with either ERP; only the API Luma reads differs.
 */
export const cin7 = createCin7Simulator({
  kinds,
  command: (context, command: JtlCommand) => jtl.command(context, command),
});

type Satisfies<T extends U, U> = T;

/** Fails to compile when the ERP model stops storing a field the Cin7 API serves. */
export type ErpRecordsServedByCin7 = [
  Satisfies<ItemRecord, ErpItem>,
  Satisfies<CustomerRecord, ErpCustomer>,
  Satisfies<SupplierRecord, ErpSupplier>,
  Satisfies<OrderRecord, ErpOrder>,
  Satisfies<NoteRecord, ErpNote>,
  Satisfies<PurchaseOrderRecord, ErpPurchaseOrder>,
];
