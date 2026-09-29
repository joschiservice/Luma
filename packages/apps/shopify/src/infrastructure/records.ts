import { ConnectorError } from '@luma/connections';
import {
  API_VERSION,
  createClient,
  fail,
  parse,
  type ShopifyTransportOptions,
} from '@luma/connector-shopify';
import { z } from 'zod';

import {
  recordKinds,
  type ShopifyRecordDetail,
  type ShopifyRecordKind,
  type ShopifyRecordRow,
  type ShopifyRecordSection,
} from '../domain/records.js';
import * as s from './record-schemas.js';

const workScopes = [
  'read_merchant_managed_fulfillment_orders',
  'read_assigned_fulfillment_orders',
  'read_third_party_fulfillment_orders',
];
const orderFields =
  'id name createdAt updatedAt displayFinancialStatus displayFulfillmentStatus currentTotalPriceSet { shopMoney { amount currencyCode } } totalOutstandingSet { shopMoney { amount currencyCode } }';
const customerFields =
  'id updatedAt numberOfOrders amountSpent { amount currencyCode }';
const refundFields =
  'id createdAt updatedAt totalRefundedSet { shopMoney { amount currencyCode } } order { id }';
const returnFields = 'id name status order { id }';
const workFields =
  'id updatedAt status requestStatus order { id } assignedLocation { location { id } } fulfillmentHolds { id reason }';
const variantFields =
  'id title sku price updatedAt product { id } inventoryItem { id }';
const row = (
  id: string,
  fields: ShopifyRecordRow['fields'],
  sourceUpdatedAt: string | null = null,
  links: ShopifyRecordRow['links'] = [],
): ShopifyRecordRow => ({ id, sourceUpdatedAt, fields, links });
const link = (kind: ShopifyRecordKind, id: string, label: string) => ({
  kind,
  id,
  label,
});
const money = (value: { amount: string; currencyCode: string }) =>
  `${value.amount} ${value.currencyCode}`;
const mapOrder = (v: z.infer<typeof s.orderDetail>) =>
  row(
    v.id,
    {
      Name: v.name,
      Created: v.createdAt,
      Payment: v.displayFinancialStatus,
      Fulfillment: v.displayFulfillmentStatus,
      Total: money(v.currentTotalPriceSet.shopMoney),
      Outstanding: money(v.totalOutstandingSet.shopMoney),
    },
    v.updatedAt,
    [link('Order', v.id, v.name)],
  );
const mapCustomer = (v: z.infer<typeof s.customer>) =>
  row(
    v.id,
    { Orders: v.numberOfOrders, Spent: money(v.amountSpent) },
    v.updatedAt,
    [link('Customer', v.id, 'Customer')],
  );
const mapRefund = (v: z.infer<typeof s.refund>) =>
  row(
    v.id,
    { Created: v.createdAt, Refunded: money(v.totalRefundedSet.shopMoney) },
    v.updatedAt,
    [link('Refund', v.id, 'Refund'), link('Order', v.order.id, 'Order')],
  );
const mapReturn = (v: z.infer<typeof s.returnRecord>) =>
  row(v.id, { Name: v.name, Status: v.status }, null, [
    link('Return', v.id, v.name),
    link('Order', v.order.id, 'Order'),
  ]);
const mapWork = (v: z.infer<typeof s.fulfillmentOrderDetail>) =>
  row(
    v.id,
    {
      Status: v.status,
      Request: v.requestStatus,
      Location: v.assignedLocation.location?.id ?? null,
      Holds:
        v.fulfillmentHolds.map((h) => `${h.reason} (${h.id})`).join(', ') ||
        'None',
    },
    v.updatedAt,
    [
      link('FulfillmentOrder', v.id, 'Fulfillment order'),
      link('Order', v.order.id, 'Order'),
    ],
  );
const mapVariant = (v: z.infer<typeof s.variantDetail>) =>
  row(v.id, { Title: v.title, SKU: v.sku, Price: v.price }, v.updatedAt, [
    link('ProductVariant', v.id, v.title),
    link('Product', v.product.id, 'Product'),
    link('InventoryItem', v.inventoryItem.id, 'Inventory'),
  ]);

/** Reads live, allowlisted Shopify records. Every request must resolve currently authorized credentials. */
export function createShopifyRecordReader(
  options: ShopifyTransportOptions & {
    tenantId: string;
    connectionId: string;
    /** Enable only after Shopify approves this deployment's protected customer data access. */
    protectedCustomerDataApproved: boolean;
    now?: () => Date;
  },
) {
  const request = createClient(options);

  return async (
    kind: ShopifyRecordKind,
    id?: string,
    cursor?: string,
  ): Promise<ShopifyRecordDetail> => {
    parse(z.enum(recordKinds), kind);
    if (
      cursor &&
      (!['Order', 'Product'].includes(kind) || id || cursor.length > 4096)
    )
      fail('invalid_input');
    if (id && !new RegExp(`^gid://shopify/${kind}/[0-9]+$`).test(id))
      fail('invalid_input');
    const access = parse(
      z.object({
        currentAppInstallation: z.object({
          accessScopes: z.array(z.object({ handle: z.string() })),
        }),
      }),
      await request(
        'query LumaRecordAccess { currentAppInstallation { accessScopes { handle } } }',
        {},
      ),
    );
    const scopes = new Set(
      access.currentAppInstallation.accessScopes.map((v) => v.handle),
    );
    const has = (scope: string) =>
      scopes.has(scope) || scopes.has(scope.replace(/^read_/, 'write_'));
    const sections: ShopifyRecordSection[] = [];

    async function node<T>(
      type: string,
      fields: string,
      schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    ): Promise<T> {
      const data = await request(
        `query LumaRecord($id: ID!) { node(id: $id) { ... on ${type} { ${fields} } } }`,
        { id },
      );
      if (data.node === null) fail('not_found');

      return parse(schema, data.node);
    }

    async function section(
      key: string,
      title: string,
      requiredScopes: string[],
      read: () => Promise<ShopifyRecordRow[]>,
      protectedData = false,
      anyScope = false,
    ) {
      const result: ShopifyRecordSection = {
        key,
        title,
        requiredScopes,
        status: 'available',
        message: null,
        rows: [],
      };
      sections.push(result);
      if (protectedData && !options.protectedCustomerDataApproved) {
        result.status = 'approval_required';
        result.message =
          'Protected customer data access must be approved for this app before customer context can be read.';

        return;
      }
      if (!(anyScope ? requiredScopes.some(has) : requiredScopes.every(has))) {
        result.status = 'missing_scope';
        result.message = `Reconnect Shopify with ${requiredScopes.join(anyScope ? ' or ' : ', ')}.`;

        return;
      }
      try {
        result.rows = await read();
        if (anyScope && !requiredScopes.every(has)) {
          result.status = 'partial';
          result.message =
            'Only fulfillment orders visible to the granted fulfillment scopes are included.';
        }
      } catch (error) {
        if (
          !(error instanceof ConnectorError) ||
          error.failure.code !== 'permission_denied'
        )
          throw error;
        result.status = 'access_denied';
        result.message =
          'Shopify denied this section. Check the granted scopes and protected data approval, then reconnect.';
      }
    }

    async function children<T>(
      field: string,
      fields: string,
      schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    ): Promise<T[]> {
      const values: T[] = [];
      let after: string | null = null;
      const seen = new Set<string>();
      do {
        const data = await request(
          `query LumaRecordChildren($id: ID!, $after: String) { node(id: $id) { ... on ${kind} { children: ${field}(first: 100, after: $after) { nodes { ${fields} } pageInfo { hasNextPage endCursor } } } } }`,
          { id, after },
        );
        if (data.node === null) fail('not_found');
        const parent = parse(
          z.object({ children: s.connection(schema) }),
          data.node,
        );
        values.push(...parent.children.nodes);
        const info = parent.children.pageInfo;
        if (
          info.hasNextPage &&
          (!info.endCursor || seen.has(info.endCursor) || seen.size >= 100)
        )
          fail('invalid_response');
        after = info.hasNextPage ? info.endCursor : null;
        if (after) seen.add(after);
      } while (after);

      return values;
    }

    if (!id) {
      if (kind !== 'Order' && kind !== 'Product') fail('invalid_input');
      const isOrder = kind === 'Order';
      let nextCursor: string | null = null;
      await section(
        'records',
        isOrder ? 'Recent orders' : 'Products',
        [isOrder ? 'read_orders' : 'read_products'],
        async () => {
          const data = await request(
            `query LumaRecordList($after: String) { records: ${isOrder ? 'orders(sortKey: UPDATED_AT, reverse: true,' : 'products('} first: 20, after: $after) { nodes { id ${isOrder ? 'name' : 'title'} updatedAt } pageInfo { hasNextPage endCursor } } }`,
            { after: cursor ?? null },
          );
          const page = parse(
            s.connection(
              z.object({
                id: z.string(),
                name: z.string().optional(),
                title: z.string().optional(),
                updatedAt: z.string().datetime({ offset: true }),
              }),
            ),
            data.records,
          );
          if (
            page.pageInfo.hasNextPage &&
            (!page.pageInfo.endCursor || page.pageInfo.endCursor === cursor)
          )
            fail('invalid_response');
          nextCursor = page.pageInfo.hasNextPage
            ? page.pageInfo.endCursor
            : null;

          return page.nodes.map((v) =>
            row(v.id, { Name: v.name ?? v.title ?? v.id }, v.updatedAt, [
              link(kind, v.id, v.name ?? v.title ?? v.id),
            ]),
          );
        },
      );
      if (isOrder && !has('read_all_orders'))
        sections.push({
          key: 'history',
          title: 'Order history coverage',
          status: 'partial',
          requiredScopes: ['read_all_orders'],
          message:
            'Shopify normally exposes the last 60 days of orders. Older orders require approved read_all_orders access.',
          rows: [],
        });

      return {
        tenantId: options.tenantId,
        connectionId: options.connectionId,
        shop: options.shop,
        kind,
        id: '',
        observedAt: (options.now ?? (() => new Date()))().toISOString(),
        apiVersion: API_VERSION,
        sections,
        nextCursor,
      };
    }
    if (kind === 'Order') {
      await section('order', 'Order', ['read_orders'], async () => [
        mapOrder(await node(kind, orderFields, s.orderDetail)),
      ]);
      await section('lines', 'Order lines', ['read_orders'], async () =>
        (
          await children('lineItems', 'id name quantity variant { id }', s.line)
        ).map((v) =>
          row(
            v.id,
            { Name: v.name, Quantity: v.quantity },
            null,
            v.variant ? [link('ProductVariant', v.variant.id, 'Variant')] : [],
          ),
        ),
      );
      await section(
        'transactions',
        'Transactions',
        ['read_orders'],
        async () => {
          const value = await node(
            kind,
            'transactions { id createdAt processedAt kind status gateway amountSet { shopMoney { amount currencyCode } } parentTransaction { id } }',
            z.object({ transactions: z.array(s.transaction) }),
          );

          return value.transactions.map((v) =>
            row(v.id, {
              Kind: v.kind,
              Status: v.status,
              Gateway: v.gateway,
              Amount: money(v.amountSet.shopMoney),
              Created: v.createdAt,
              Processed: v.processedAt,
              Parent: v.parentTransaction?.id ?? null,
            }),
          );
        },
      );
      await section(
        'customer',
        'Customer',
        ['read_orders', 'read_customers'],
        async () => {
          const value = await node(
            kind,
            `customer { ${customerFields} }`,
            z.object({ customer: s.customer.nullable() }),
          );

          return value.customer ? [mapCustomer(value.customer)] : [];
        },
        true,
      );
      await section(
        'fulfillment',
        'Fulfillment orders and holds',
        workScopes,
        async () =>
          (
            await children(
              'fulfillmentOrders',
              workFields,
              s.fulfillmentOrderDetail,
            )
          ).map(mapWork),
        false,
        true,
      );
      await section('returns', 'Returns', ['read_returns'], async () =>
        (await children('returns', returnFields, s.returnRecord)).map(
          mapReturn,
        ),
      );
      await section('refunds', 'Refunds', ['read_orders'], async () =>
        (
          await node(
            kind,
            `refunds { ${refundFields} }`,
            z.object({ refunds: z.array(s.refund) }),
          )
        ).refunds.map(mapRefund),
      );
      await section('events', 'Source events', ['read_orders'], async () =>
        (
          await children(
            'events',
            'id createdAt ... on BasicEvent { action }',
            s.event,
          )
        ).map((v) =>
          row(v.id, { Occurred: v.createdAt, Action: v.action ?? 'Comment' }),
        ),
      );
      if (!has('read_all_orders'))
        sections.push({
          key: 'history',
          title: 'Order history coverage',
          status: 'partial',
          requiredScopes: ['read_all_orders'],
          message:
            'Shopify normally exposes the last 60 days of orders. Older orders require approved read_all_orders access.',
          rows: [],
        });
    } else if (kind === 'Customer') {
      await section(
        'customer',
        'Customer',
        ['read_customers'],
        async () => [mapCustomer(await node(kind, customerFields, s.customer))],
        true,
      );
      await section(
        'orders',
        'Customer orders',
        ['read_customers', 'read_orders'],
        async () =>
          (await children('orders', orderFields, s.orderDetail)).map(mapOrder),
        true,
      );
      if (!has('read_all_orders'))
        sections.push({
          key: 'history',
          title: 'Order history coverage',
          status: 'partial',
          requiredScopes: ['read_all_orders'],
          message:
            'Order history is limited to the granted Shopify order window, normally 60 days.',
          rows: [],
        });
    } else if (kind === 'Product') {
      await section('product', 'Product', ['read_products'], async () => {
        const v = await node(
          kind,
          'id title status updatedAt',
          s.productDetail,
        );

        return [row(v.id, { Title: v.title, Status: v.status }, v.updatedAt)];
      });
      await section('variants', 'Variants', ['read_products'], async () =>
        (await children('variants', variantFields, s.variantDetail)).map(
          mapVariant,
        ),
      );
    } else if (kind === 'ProductVariant') {
      await section('variant', 'Variant', ['read_products'], async () => [
        mapVariant(await node(kind, variantFields, s.variantDetail)),
      ]);
    } else if (kind === 'InventoryItem') {
      await section('item', 'Inventory item', ['read_inventory'], async () => {
        const v = await node(
          kind,
          'id tracked updatedAt sku variant { id }',
          s.inventoryDetail,
        );

        return [
          row(v.id, { SKU: v.sku, Tracked: v.tracked }, v.updatedAt, [
            link('ProductVariant', v.variant.id, 'Variant'),
          ]),
        ];
      });
      await section(
        'levels',
        'Inventory by location',
        ['read_inventory', 'read_locations'],
        async () =>
          (
            await children(
              'inventoryLevels',
              'id updatedAt location { id name isActive } quantities(names: ["on_hand", "committed", "available", "incoming", "reserved"]) { name quantity }',
              s.inventoryLevel,
            )
          ).map((v) =>
            row(
              v.id,
              {
                Location: v.location.name,
                'Location ID': v.location.id,
                Active: v.location.isActive,
                ...Object.fromEntries(
                  v.quantities.map((q) => [q.name, q.quantity]),
                ),
              },
              v.updatedAt,
            ),
          ),
      );
    } else if (kind === 'FulfillmentOrder') {
      await section(
        'fulfillment',
        'Fulfillment order and holds',
        workScopes,
        async () => [
          mapWork(await node(kind, workFields, s.fulfillmentOrderDetail)),
        ],
        false,
        true,
      );
    } else if (kind === 'Return') {
      await section('return', 'Return', ['read_returns'], async () => [
        mapReturn(await node(kind, returnFields, s.returnRecord)),
      ]);
      await section('lines', 'Return lines', ['read_returns'], async () =>
        (
          await children(
            'returnLineItems',
            'id quantity returnReason ... on ReturnLineItem { fulfillmentLineItem { lineItem { id } } }',
            s.returnLine,
          )
        ).map((v) =>
          row(v.id, {
            Quantity: v.quantity,
            Reason: v.returnReason,
            'Order line': v.fulfillmentLineItem?.lineItem.id ?? null,
          }),
        ),
      );
    } else {
      await section('refund', 'Refund', ['read_orders'], async () => [
        mapRefund(await node(kind, refundFields, s.refund)),
      ]);
    }

    return {
      tenantId: options.tenantId,
      connectionId: options.connectionId,
      shop: options.shop,
      kind,
      id,
      observedAt: (options.now ?? (() => new Date()))().toISOString(),
      apiVersion: API_VERSION,
      sections,
      nextCursor: null,
    };
  };
}
