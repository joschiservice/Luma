import { exceptionClassLabel } from '@luma/exceptions';
import type { TenantContext } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';

const uuidPattern = /^[0-9a-f-]{36}$/i;

/**
 * Deliberate cross-owner reads that link messages to records and label them: canonical order
 * numbers, purchase-order references, customer profile emails, supplier names and case kinds.
 * Exact matches only, in the caller's tenant.
 */
export function createMessageRecordDirectory(database: TenantDatabase) {
  return {
    /** Orders and purchase orders whose reference equals an upper-case key exactly. */
    async references(context: TenantContext, keys: string[]) {
      return database.transaction(context.tenantId, async (tx) => {
        const orders = await tx.query<{ id: string; key: string }>(
          `SELECT entity_id AS id,upper(display_number_key) AS key FROM orders_list
          WHERE tenant_id=$1 AND selected AND display_number_key=ANY($2::text[] || ARRAY(SELECT lower(k) FROM unnest($2::text[]) k))`,
          [context.tenantId, keys],
        );
        const purchaseOrders = await tx.query<{ id: string; key: string }>(
          `SELECT o.id,k.key FROM procurement_purchase_orders o
          CROSS JOIN LATERAL (SELECT upper(o.document->>'reference') AS key
            UNION SELECT upper(r->>'externalId') FROM jsonb_array_elements(COALESCE(o.document->'externalReferences','[]')) r) k
          WHERE o.tenant_id=$1 AND k.key=ANY($2::text[])`,
          [context.tenantId, keys],
        );

        return [
          ...orders.rows.map((r) => ({ kind: 'order' as const, ...r })),
          ...purchaseOrders.rows.map((r) => ({
            kind: 'purchase_order' as const,
            ...r,
          })),
        ];
      });
    },
    /** Customer profiles by lower-case email. */
    async customers(context: TenantContext, emails: string[]) {
      return database.transaction(
        context.tenantId,
        async (tx) =>
          (
            await tx.query<{ id: string; email: string }>(
              'SELECT id,email_key AS email FROM customer_profiles WHERE tenant_id=$1 AND email_key=ANY($2::text[])',
              [context.tenantId, emails],
            )
          ).rows,
      );
    },
    /** Display labels keyed `kind:id`; records that don't exist are absent. */
    async labels(
      context: TenantContext,
      records: { kind: string; id: string }[],
    ) {
      const uuids = (kind: string) =>
        records
          .filter((r) => r.kind === kind && uuidPattern.test(r.id))
          .map((r) => r.id);

      return database.transaction(context.tenantId, async (tx) => {
        const labels = new Map<string, string>();
        const add = (
          kind: string,
          rows: { id: string; label: string | null }[],
        ) => {
          for (const row of rows)
            labels.set(`${kind}:${row.id}`, row.label ?? 'Unnamed');
        };
        if (uuids('order').length)
          add(
            'order',
            (
              await tx.query<{ id: string; label: string | null }>(
                `SELECT entity_id AS id,COALESCE(display_number,'Order') AS label FROM orders_list
                WHERE tenant_id=$1 AND selected AND entity_id=ANY($2::uuid[])`,
                [context.tenantId, uuids('order')],
              )
            ).rows,
          );
        if (uuids('customer').length)
          add(
            'customer',
            (
              await tx.query<{ id: string; label: string | null }>(
                `SELECT id,COALESCE(display_name,email,'Customer') AS label FROM customer_profiles
                WHERE tenant_id=$1 AND id=ANY($2::uuid[])`,
                [context.tenantId, uuids('customer')],
              )
            ).rows,
          );
        if (uuids('supplier').length)
          add(
            'supplier',
            (
              await tx.query<{ id: string; label: string | null }>(
                "SELECT id,document->>'name' AS label FROM procurement_suppliers WHERE tenant_id=$1 AND id=ANY($2::uuid[])",
                [context.tenantId, uuids('supplier')],
              )
            ).rows,
          );
        if (uuids('purchase_order').length)
          add(
            'purchase_order',
            (
              await tx.query<{ id: string; label: string | null }>(
                "SELECT id,document->>'reference' AS label FROM procurement_purchase_orders WHERE tenant_id=$1 AND id=ANY($2::uuid[])",
                [context.tenantId, uuids('purchase_order')],
              )
            ).rows,
          );
        if (uuids('case').length)
          add(
            'case',
            (
              await tx.query<{ id: string; kind: string }>(
                "SELECT id,document->>'exceptionClass' AS kind FROM exceptions WHERE tenant_id=$1 AND id=ANY($2::uuid[])",
                [context.tenantId, uuids('case')],
              )
            ).rows.map((row) => ({
              id: row.id,
              label: exceptionClassLabel(row.kind),
            })),
          );

        return labels;
      });
    },
    /** The supplier of each purchase order. */
    async orderSuppliers(context: TenantContext, orderIds: string[]) {
      return database.transaction(
        context.tenantId,
        async (tx) =>
          new Map(
            (
              await tx.query<{ id: string; supplier_id: string }>(
                'SELECT id,supplier_id FROM procurement_purchase_orders WHERE tenant_id=$1 AND id=ANY($2::uuid[])',
                [context.tenantId, orderIds],
              )
            ).rows.map((row) => [row.id, row.supplier_id]),
          ),
      );
    },
  };
}

/**
 * Deliberate cross-owner reads for matching document facts: catalog SKU codes and supplier
 * names. Exact matches only, after trimming and case folding.
 */
export function createMessageDocumentDirectory(database: TenantDatabase) {
  return {
    /** Catalog SKU codes that exist among `codes` (trimmed, upper case). */
    async skus(context: TenantContext, codes: string[]) {
      return database.transaction(
        context.tenantId,
        async (tx) =>
          new Set(
            (
              await tx.query<{ code: string }>(
                `SELECT DISTINCT upper(btrim(code)) AS code FROM inventory_product_skus
                WHERE tenant_id=$1 AND code_key=ANY($2::text[])`,
                [context.tenantId, codes.map((code) => code.toLowerCase())],
              )
            ).rows.map((row) => row.code),
          ),
      );
    },
    /** Suppliers whose lower-case, trimmed name is one of `names`. */
    async suppliers(context: TenantContext, names: string[]) {
      return database.transaction(
        context.tenantId,
        async (tx) =>
          (
            await tx.query<{ id: string; key: string }>(
              `SELECT id,lower(btrim(document->>'name')) AS key FROM procurement_suppliers
              WHERE tenant_id=$1 AND lower(btrim(document->>'name'))=ANY($2::text[])`,
              [context.tenantId, names],
            )
          ).rows,
      );
    },
  };
}
