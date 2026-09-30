# Inventory workspace

Inventory groups current canonical stock projections by SKU, location and unit.
Each connection keeps its own quantities. Search matches the canonical SKU key,
source SKU and location IDs, and canonical identifiers. Source filters select
positions without hiding their other sources. Lists use 50-position keyset pages;
cursors belong to the tenant and filters that produced them.

Known decimal quantities are compared at their canonical six-decimal precision.
Missing values never become zero. Removed snapshots remain visible as provenance
but do not participate in comparisons. Observation time, source update time,
connection status and reported versus derived availability remain separate facts.
No source is implicitly authoritative and quantities are never summed across sources.

The detail page includes up to 100 observed snapshots and 50 entries per related
record type. Order lines use canonical SKU relationships and retain source and
unit. Purchase orders match the canonical SKU ID or reconciliation key, which
replenishment uses for its SKU field. They are commitments, not confirmed receipts
or incoming stock; the current model has no receipt progress or location allocation.
Provider incoming quantities are not available in current canonical projections and
are explicitly unknown in the UI. SKUs are labeled with a source SKU code from the
product catalog when one is known, otherwise with the canonical key (shortened for
imported records). `skuKey` keeps the canonical key that purchase orders use. The
detail page lists the sources behind the SKU and lets owners and admins link or
unlink matching SKUs from other sources. **Product listings for this SKU** opens the
[Products workspace](products-workspace.md).

Inventory can be reached from the sidebar (`G`, then `V`), stock metric drilldowns,
SKU issues and record details. Search and list filters survive detail navigation.

Entry points: `packages/read-models/src/infrastructure/inventory`, the
`inventory` API contract, and `apps/web/src/features/inventory`. Reads use tenant
transactions and existing read grants. Validation covers decimal comparisons,
API scope and paging, the browser investigation journey, and Inventory Storybook
states in both themes.
