import { nativeStockContract } from '../contracts/native-stock.js';

/** Routes served by `@luma/inventory`. */
type InventoryContracts = {
  nativeStock: typeof nativeStockContract;
};

/** Routes served by `@luma/inventory`, keyed by area. */
export const inventoryContracts: InventoryContracts = {
  nativeStock: nativeStockContract,
};
