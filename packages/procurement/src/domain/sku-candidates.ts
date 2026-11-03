import { sqlUuid } from '@luma/platform';

/**
 * Builds a `SELECT` of the inventory entity IDs a supplier or order SKU key can name: the entity
 * ID, its reconciliation key or an exact product code. `tenant` and `key` are trusted SQL
 * expressions, and `key` must be text. Each branch uses its own index, because an `OR` of them
 * would scan the tenant's SKUs. Callers still filter the result to `kind='sku'` entities.
 */
export function skuCandidateIdsSql(tenant: string, key: string): string {
  return `SELECT ${sqlUuid(key)} AS id
    UNION SELECT candidate.id FROM inventory_entities candidate
      WHERE candidate.tenant_id=${tenant} AND candidate.kind='sku' AND candidate.reconciliation_key=${key}
    UNION SELECT product.sku_id FROM inventory_product_skus product
      WHERE product.tenant_id=${tenant} AND product.code_key=lower(btrim(${key})) AND product.code=${key}`;
}
