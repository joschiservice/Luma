import { guid } from '@luma/simulator-cin7';

/**
 * The merchant's ERP in a simulator run and how Luma identifies its records. JTL reports numeric
 * record IDs and sells the stock of all warehouses through one `all-warehouses` location; Cin7
 * reports GUIDs and one location per warehouse.
 * @param {any} manifest pilot manifest with `simulator.erp`
 */
export function erpOf(manifest) {
  const erp = manifest.simulator?.erp ?? { name: 'jtl', kind: 'jtl' };
  const cin7 = erp.kind === 'cin7';

  return {
    ...erp,
    connectionId: manifest.connections[erp.name],
    /** The SKU of a catalog variant. */
    sku: (id) => (cin7 ? guid('product', id) : id),
    /** A supplier of the generated catalog. */
    supplier: (id) => (cin7 ? guid('supplier', id) : id),
    /** The ERP location whose stock a shop location sells. */
    location: (warehouse) =>
      cin7 ? guid('location', warehouse) : 'all-warehouses',
  };
}
