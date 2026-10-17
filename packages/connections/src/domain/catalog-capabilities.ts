import type {
  CustomerSnapshot,
  Page,
  PageQuery,
  ProductSnapshot,
} from './capabilities.js';

/** Product and customer reads. */
export interface CatalogCapabilities {
  'products.read': { input: PageQuery; output: Page<ProductSnapshot> };
  'customers.read': { input: PageQuery; output: Page<CustomerSnapshot> };
}
