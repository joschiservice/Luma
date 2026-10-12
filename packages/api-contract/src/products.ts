import { z } from 'zod';

import { stockPositionSchema } from './inventory.js';

const timestamp = z.string().datetime({ offset: true });

const productStatusSchema = z.enum(['active', 'draft', 'archived', 'unknown']);

const listPriceSchema = z.object({
  amount: z.string(),
  currency: z.string().nullable(),
});

const catalogFieldSchema = z.enum([
  'title',
  'status',
  'published',
  'price',
  'barcode',
]);

const catalogViewSchema = z.enum(['all', 'differs', 'missing', 'unlinked']);

const catalogListingSchema = z.object({
  connectionId: z.string().uuid(),
  productId: z.string().uuid(),
  externalProduct: z.string().nullable(),
  externalSku: z.string().nullable(),
  code: z.string().nullable(),
  productTitle: z.string().nullable(),
  variantTitle: z.string().nullable(),
  status: productStatusSchema,
  published: z.boolean().nullable(),
  vendor: z.string().nullable(),
  barcode: z.string().nullable(),
  price: listPriceSchema.nullable(),
  unit: z.string(),
  observedAt: timestamp,
  requiresComponents: z.boolean().nullable().optional(),
  sourceUpdatedAt: timestamp.nullable(),
});

const catalogItemSchema = z.object({
  skuId: z.string().uuid(),
  sku: z.string(),
  skuKey: z.string(),
  title: z.string().nullable(),
  listings: z.array(catalogListingSchema),
  differences: z.array(catalogFieldSchema),
  gaps: z.array(
    z.object({
      connectionId: z.string().uuid(),
      match: z.object({ skuId: z.string().uuid(), sku: z.string() }).nullable(),
    }),
  ),
});

const catalogSourceSchema = z.object({
  connectionId: z.string().uuid(),
  label: z.string(),
  system: z.string().nullable(),
  status: z.string(),
  skuCount: z.number().int().nonnegative(),
  fullReadAt: timestamp.nullable(),
  lastReadAt: timestamp.nullable(),
  failing: z.boolean(),
});

export const productQuerySchema = z
  .object({
    q: z.string().trim().max(120).default(''),
    view: catalogViewSchema.default('all'),
    connectionId: z.string().uuid().optional(),
    missingFrom: z.string().uuid().optional(),
    cursor: z.string().min(1).max(8192).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(50),
  })
  .strict();

export const productListSchema = z.object({
  items: z.array(catalogItemSchema),
  sources: z.array(catalogSourceSchema),
  counts: z.partialRecord(catalogViewSchema, z.number().int().nonnegative()),
  nextCursor: z.string().nullable(),
  asOf: timestamp,
});

const sourceRef = z.object({ externalId: z.string(), scopeKey: z.string() });
const bundleRecipeSchema = z.object({
  variant: sourceRef,
  requiresComponents: z.boolean(),
  components: z
    .array(
      z.object({
        sourceId: sourceRef,
        sourceVariant: sourceRef,
        sourceSku: sourceRef.nullable(),
        skuId: z.string().uuid().nullable(),
        skuLabel: z.string().nullable().optional(),
        quantity: z.string(),
      }),
    )
    .max(5000)
    .nullable(),
});

export const productDetailSchema = z.object({
  bundles: z
    .array(
      bundleRecipeSchema.extend({
        connectionId: z.string().uuid(),
        productId: z.string().uuid(),
        observedAt: timestamp,
        sourceUpdatedAt: timestamp.nullable(),
      }),
    )
    .optional(),
  item: catalogItemSchema,
  sources: z.array(catalogSourceSchema),
  variants: z.array(
    z.object({
      skuId: z.string().uuid(),
      sku: z.string(),
      title: z.string().nullable(),
      connectionId: z.string().uuid(),
      status: productStatusSchema,
    }),
  ),
  history: z.object({
    entries: z.array(
      z.object({
        id: z.string().uuid(),
        connectionId: z.string().uuid(),
        current: z.boolean(),
        deleted: z.boolean(),
        observedAt: timestamp,
        sourceUpdatedAt: timestamp.nullable(),
        productTitle: z.string().nullable(),
        status: productStatusSchema.nullable(),
        published: z.boolean().nullable(),
        price: listPriceSchema.nullable(),
        bundle: bundleRecipeSchema.nullable().optional(),
      }),
    ),
    truncated: z.boolean(),
  }),
  stock: z.array(stockPositionSchema),
  sales: z.object({
    since: timestamp,
    sources: z.array(
      z.object({
        connectionId: z.string().uuid(),
        unit: z.string(),
        orders: z.number().int().nonnegative(),
        quantity: z.string(),
        lastPlacedAt: timestamp.nullable(),
        daily: z.array(z.object({ date: z.string(), quantity: z.string() })),
      }),
    ),
  }),
  orders: z.array(
    z.object({
      id: z.string().uuid(),
      label: z.string(),
      status: z.string(),
      connectionId: z.string().uuid(),
      quantity: z.string(),
      unit: z.string(),
      placedAt: timestamp.nullable(),
    }),
  ),
  purchaseOrders: z.array(
    z.object({
      id: z.string().uuid(),
      label: z.string(),
      status: z.string(),
      quantity: z.number(),
      unit: z.string(),
    }),
  ),
  issues: z.array(
    z.object({ id: z.string().uuid(), label: z.string(), state: z.string() }),
  ),
  relatedTruncated: z.boolean(),
  asOf: timestamp,
});

export type CatalogField = z.infer<typeof catalogFieldSchema>;

export type CatalogView = z.infer<typeof catalogViewSchema>;

export type CatalogListing = z.infer<typeof catalogListingSchema>;

export type CatalogItem = z.infer<typeof catalogItemSchema>;

export type CatalogSource = z.infer<typeof catalogSourceSchema>;

export type ProductList = z.infer<typeof productListSchema>;

export type ProductDetail = z.infer<typeof productDetailSchema>;
