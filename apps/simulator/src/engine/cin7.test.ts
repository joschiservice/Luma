import type {
  ErpCustomer,
  ErpItem,
  ErpNote,
  ErpOrder,
  ErpPurchaseOrder,
  ErpSupplier,
} from '@luma/simulator-cin7';
import type {
  CustomerRecord,
  ItemRecord,
  NoteRecord,
  OrderRecord,
  PurchaseOrderRecord,
  SupplierRecord,
} from '@luma/simulator-jtl';
import { describe, expectTypeOf, it } from 'vitest';

describe('cin7 engine', () => {
  // Type checking fails when the ERP model stops storing a field the Cin7 API serves.
  it('stores every field the Cin7 API serves', () => {
    expectTypeOf<ItemRecord>().toExtend<ErpItem>();
    expectTypeOf<CustomerRecord>().toExtend<ErpCustomer>();
    expectTypeOf<SupplierRecord>().toExtend<ErpSupplier>();
    expectTypeOf<OrderRecord>().toExtend<ErpOrder>();
    expectTypeOf<NoteRecord>().toExtend<ErpNote>();
    expectTypeOf<PurchaseOrderRecord>().toExtend<ErpPurchaseOrder>();
  });
});
