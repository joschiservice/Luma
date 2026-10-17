import { procurementContract } from '../contracts/procurement.js';
import { procurementChangesContract } from '../contracts/purchase-order-changes.js';
import { scopedFollowUpsContract } from '../contracts/scoped-follow-ups.js';
import { supplierEmailContract } from '../contracts/supplier-email.js';

/** Routes served by `@luma/procurement`. */
type ProcurementContracts = {
  procurement: typeof procurementContract;
  procurementChanges: typeof procurementChangesContract;
  procurementEmail: typeof supplierEmailContract;
  scopedFollowUps: typeof scopedFollowUpsContract;
};

/** Routes served by `@luma/procurement`, keyed by area. */
export const procurementContracts: ProcurementContracts = {
  procurement: procurementContract,
  procurementChanges: procurementChangesContract,
  procurementEmail: supplierEmailContract,
  scopedFollowUps: scopedFollowUpsContract,
};
