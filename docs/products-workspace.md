# Products workspace

Products lists canonical SKUs from the connected catalogs and compares how each source
lists them. It reads the product projections described in
[canonical commerce projections](commerce-projections.md#imports-products-and-links) and
never writes commerce data or source listings.

Code: `@luma/read-models` (reads); Inventory owns the `inventory_product_skus` rows.

## Model

A canonical SKU is the only identity shared across sources: every source product is its
own canonical product, and products relate only through linked SKUs. A row is therefore one
SKU, and each catalog source contributes a listing: its product and variant titles, SKU
code, status, sales channel publication, vendor, list price and barcode. A SKU that appears
in several products of one source keeps every listing.

A **catalog source** is a connection with at least one current product. A **gap** is a
catalog source that currently lists none of the SKU. Absence is only established after a
full catalog read; the read model reports each source's last completed full products scan
and the UI says when it is missing. A gap's **match** is another SKU in that source with the
same normalized SKU code. Matches are suggestions for the reviewed link flow; they are never
merged automatically.

| Rule              | Definition                                                                                                                        |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Title differs     | Product plus variant title, lowercased with every non-alphanumeric character removed, differs between listings.                   |
| Status differs    | Known statuses (`active`, `draft`, `archived`) differ. `unknown` is not compared.                                                 |
| Published differs | Reported sales channel publication differs. Shopify reports Online Store publication; JTL reports shop activation.                |
| Price differs     | Amounts differ within one reported currency. Prices without a currency (JTL items) and prices in other currencies are shown only. |
| Barcode differs   | Barcodes without surrounding space and leading zeros differ, so UPC-A and EAN-13 forms of one code agree.                         |
| Missing           | The SKU is absent from at least one catalog source.                                                                               |
| Unlinked          | A gap has a match.                                                                                                                |

Each rule is written once and serves the list, the per-view counts and the detail read. The
title and barcode comparison keys are generated columns, computed on write.

## Storage

Inventory replaces a product's catalog rows in the same transaction as its projection
pointer and removes them for tombstones and retired projections. Product snapshots written
before the adapters reported these facts show them as not reported until the next import.

## Reads

Reads run in one read-only, repeatable-read transaction under the API login, which reads
the catalog, mappings and orders through `luma_case_reader`, purchase orders through
`luma_desk` and sync streams through `luma_commerce_sync`. The list raises `work_mem` to
32 MB for its own transaction.

The list returns at most 50 SKUs per page, the catalog sources and counts for every view
under the current search and source filters. Search is literal. `connectionId` keeps SKUs
listed in a source and `missingFrom` keeps SKUs absent from it; both keep every listing for
comparison. The keyset cursor is bound to the tenant and filters.

The detail read accepts any canonical SKU, including one known only from stock or order
lines. It adds other variants of the same source products, up to 50 listing snapshots,
stock positions, 30 days of units ordered per source, orders (open first), purchase orders
and SKU or position issues. Sales use placed dates, exclude cancelled orders, subtract
reported cancelled quantities and are never added across sources, because systems can hold
the same order. Orders come from the order list's SKU relationships; a tenant still
[rebuilding the order list](orders-workspace.md#backfill-and-rollout) scans current orders
instead.

## Limits

Every list read compares the tenant's whole catalog, so its cost grows with the number of
listings. Reads stayed around 200 ms or less at 20,000 SKUs listed in two sources on a
development laptop. Catalogs well beyond 20,000 SKUs need a maintained per-SKU comparison
projection, as `orders_list` is for orders. Re-measure with
`LUMA_PRODUCT_BENCHMARK=<SKU count>` on `products.e2e.mjs`.
