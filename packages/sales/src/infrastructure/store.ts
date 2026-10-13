import { IdentityError } from '@luma/identity';
import type { SqlTransaction } from '@luma/platform';

import type { SalesEdit, SalesLine, SalesOrder } from '../domain/order.js';

/** Sales-owned persistence. The caller supplies the tenant transaction and owner publication ports. */
export function createSalesStore(
  tx: SqlTransaction,
  tenantId: string,
  actorId: string,
) {
  return {
    async get(orderId: string, lock = true): Promise<SalesOrder | null> {
      const rows = await tx.query<{ document: Omit<SalesOrder, 'lines'> }>(
        `SELECT document FROM sales_orders WHERE tenant_id=$1 AND order_id=$2 ${lock ? 'FOR UPDATE' : ''}`,
        [tenantId, orderId],
      );
      const order = rows.rows[0]?.document;
      if (!order) return null;
      const lines = await tx.query<{ document: SalesLine }>(
        'SELECT document FROM sales_order_lines WHERE tenant_id=$1 AND sales_order_id=$2 ORDER BY position',
        [tenantId, order.id],
      );

      // Lines stored before tax inclusion was recorded have it as unknown.
      return {
        ...order,
        lines: lines.rows.map((row) => ({
          ...row.document,
          taxIncluded: row.document.taxIncluded ?? null,
        })),
      };
    },
    async save(order: SalesOrder) {
      const { lines, ...document } = order;
      const saved = await tx.query(
        `INSERT INTO sales_orders(tenant_id,id,order_id,connection_id,number,status,currency,version,customer_id,billing_address,shipping_address,channel,document)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(tenant_id,order_id) DO UPDATE SET
        status=EXCLUDED.status,version=EXCLUDED.version,billing_address=EXCLUDED.billing_address,
        shipping_address=EXCLUDED.shipping_address,document=EXCLUDED.document
        WHERE sales_orders.version=EXCLUDED.version-1 RETURNING id`,
        [
          tenantId,
          order.id,
          order.orderId,
          order.connectionId,
          order.number,
          order.status,
          order.currency,
          order.version,
          order.customerId,
          order.billingAddress,
          order.shippingAddress,
          order.channel,
          document,
        ],
      );
      if (!saved.rows.length)
        throw new IdentityError(
          409,
          'CONFLICT',
          'Order changed; reload and retry',
        );
      for (const [position, line] of lines.entries())
        await tx.query(
          `INSERT INTO sales_order_lines(tenant_id,sales_order_id,id,position,sku_id,quantity,current_quantity,unit_price,tax_included,tax_rate,document)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(tenant_id,sales_order_id,id) DO UPDATE SET
        current_quantity=EXCLUDED.current_quantity,document=EXCLUDED.document`,
          [
            tenantId,
            order.id,
            line.id,
            position,
            line.skuId,
            line.quantity,
            line.currentQuantity,
            line.unitPrice,
            line.taxIncluded,
            line.taxRate,
            line,
          ],
        );
    },
    async receipt(commandId: string, orderId: string, input: SalesEdit) {
      const rows = await tx.query<{ matches: boolean; result: SalesOrder }>(
        `SELECT result, actor_id=$3 AND order_id=$4 AND input=$5::jsonb AS matches
        FROM sales_commands WHERE tenant_id=$1 AND command_id=$2`,
        [tenantId, commandId, actorId, orderId, input],
      );
      const previous = rows.rows[0];
      if (previous && !previous.matches)
        throw new IdentityError(409, 'CONFLICT', 'Command ID already used');

      return previous?.result ?? null;
    },
    async remember(
      commandId: string,
      orderId: string,
      input: SalesEdit,
      order: SalesOrder,
    ) {
      await tx.query(
        'INSERT INTO sales_commands(tenant_id,command_id,actor_id,order_id,input,result) VALUES($1,$2,$3,$4,$5,$6)',
        [tenantId, commandId, actorId, orderId, input, order],
      );
    },
  };
}
