# @luma/orders

Owns canonical orders, order lines, fulfillment identities and their projections, including the maintained order list rows and search links.

Provider payload translation belongs to connections. Inventory reference validation is injected, and commerce-ingestion coordinates updates across owners. Canonical identities stay stable during replay. Order state rules are exported as SQL building blocks for read-models.

## Public entry points

- `@luma/orders`
- `@luma/orders/composition`

## Further reading

- [Orders workspace and list backfill](../../docs/orders-workspace.md)
- [Commerce projections](../../docs/commerce-projections.md)
- [Package boundaries and runtime composition](../../docs/architecture/005-domain-packages-and-runtimes.md)
