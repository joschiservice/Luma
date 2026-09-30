# Products workspace

Products lists canonical SKUs from the connected catalogs and compares how each source
lists them. It reads the product projections described in
[canonical commerce projections](commerce-projections.md#imports-products-and-links) and
never writes commerce data or source listings.

## Model

A canonical SKU is the only identity shared across sources: every source product is its
own canonical product, and products relate only through linked SKUs. A row is therefore
one SKU, and each catalog source contributes a listing: its product and variant titles,
SKU code, status, sales channel publication, vendor, list price and barcode. A SKU that
appears in several products of one source keeps every listing.

A **catalog source** is a connection with at least one current product. A **gap** is a
catalog source that currently lists none of the SKU. Absence is only established after a
full catalog read; the read model reports each source's last completed full products scan
(`commerce_sync_streams.last_full_scan_at`) and the UI says when it is missing. A gap's
**match** is another SKU in that source with the same normalized SKU code. Matches are
suggestions for the reviewed link flow; they are never merged automatically.

| Rule              | Definition                                                                                                                        |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Title differs     | Product plus variant title, lowercased with every non-alphanumeric character removed, differs between listings.                   |
| Status differs    | Known statuses (`active`, `draft`, `archived`) differ. `unknown` is not compared.                                                 |
| Published differs | Reported sales channel publication differs. Shopify reports Online Store publication; JTL reports shop activation.                |
| Price differs     | Amounts differ within one reported currency. Prices without a currency (JTL items) and prices in other currencies are shown only. |
| Barcode differs   | Barcodes without surrounding space and leading zeros differ, so UPC-A and EAN-13 forms of one code agree.                         |
| Missing           | The SKU is absent from at least one catalog source.                                                                               |
| Unlinked          | A gap has a match.                                                                                                                |

Each rule is written once, in `packages/read-models/src/infrastructure/products/catalog.ts`,
and serves the list, the per-view counts and the detail read. The title and barcode keys
are generated columns of `inventory_product_skus`, so they are computed on write.

## Storage

Inventory owns `inventory_product_skus`. Migration `0043_product_catalog.sql` adds the
current snapshot ID, product title and status, vendor, publication, variant title,
barcode, price, unit and read times, backfills them from current snapshots, and adds the
comparison keys. The owner replaces a product's rows in the same transaction as its
projection pointer, and removes them for tombstones and retired projections. Adapters
populate the new facts at `shopify/2` and `jtl/2`; older product snapshots show them as
not reported until the next import.

## Read model

`createProductWorkspace` in `packages/read-models/src/infrastructure/products/workspace.ts`
implements `ProductWorkspace`. Reads run in one read-only, repeatable-read transaction
under the API login, which reads the catalog, mappings and orders through
`luma_case_reader`, purchase orders through `luma_desk` and sync streams through
`luma_commerce_sync`. The list raises `work_mem` to 32 MB for its own transaction.

The list returns up to `limit` SKUs (at most 50), the catalog sources and counts for every
view under the current search and source filters. Search matches listing text, barcodes,
vendors and source product or SKU IDs literally. `connectionId` keeps SKUs listed in a
source and `missingFrom` keeps SKUs absent from it; both keep every listing for
comparison. Pages use a keyset cursor over the SKU code, title and ID, bound to the
tenant and filters.

The detail read accepts any canonical SKU, including one known only from stock or order
lines. It adds other variants of the same source products, up to 50 listing snapshots,
the stock positions from the Inventory read model, 30 days of units ordered per source,
orders (open first), purchase orders and SKU or position issues. Sales use placed dates,
exclude cancelled orders, subtract reported cancelled quantities and are never added
across sources, because systems can hold the same order. Orders come from
`orders_list_skus`; a tenant still rebuilding the order list scans current orders instead.

## Web

`apps/web/src/features/products` holds the list (`page.tsx`), detail (`detail.tsx`), the
sales bars (`sales.tsx`), URL state (`data.ts`) and wording (`presentation.ts`). The list
shows one column per catalog source. The detail page compares fields with sources as
columns, explains each gap, and embeds the SKU link controls from Data sync. Products is
in the sidebar (`G`, then `K`), the command menu opens SKU records there, and order lines,
stock positions, SKU issues and the Records explorer link to it. The optional **Catalog
health** Home module shows the view counts.

## Measurements

`apps/api/e2e/products.e2e.mjs` includes a benchmark. Set `LUMA_PRODUCT_BENCHMARK` to a SKU
count; each SKU is listed in two sources and a tenth have only an unlinked match. It
writes the fastest of three API requests per read to `/tmp/luma101-products-<count>.json`.
Measured on PostgreSQL 17 in Docker on a development laptop:

| Read (ms)        | 5,000 SKUs | 20,000 SKUs |
| ---------------- | ---------: | ----------: |
| First page       |         36 |         158 |
| Differs view     |         32 |         156 |
| Selective search |         24 |         131 |
| Broad search     |         40 |         198 |
| Deep page        |         33 |         158 |
| Detail           |         22 |          37 |

Every list read compares the tenant's whole catalog, so its cost grows with the number of
listings. Catalogs well beyond 20,000 SKUs need a maintained per-SKU comparison
projection, as `orders_list` is for orders.

## Validation

```sh
pnpm --filter @luma/app-shopify test
pnpm --filter @luma/app-jtl test
pnpm --filter @luma/web exec vitest run src/features/products
pnpm --filter @luma/ui exec vitest run ../../apps/web/src/features/products/products.stories.tsx
pnpm test:e2e products.e2e.mjs
pnpm test:browser products.browser.mjs
```
