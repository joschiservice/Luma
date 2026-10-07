# @luma/read-models

Read-only, cross-owner workspace views: the record explorer, operational metrics and summary, the Orders, Inventory, Products, Fulfillment and Returns workspaces, the Needs you queue, Insights and procurement context.

Each read runs in one read-only, repeatable-read transaction under the tenant's row security. Business rules come from their owners as injected SQL building blocks, such as order state from `@luma/orders` and case attention from `@luma/exceptions`. This package never writes and owns no tables.

## Public entry points

- `@luma/read-models`
- `@luma/read-models/composition`
- `@luma/read-models/http`

## Further reading

- [Workspace read models](../../docs/architecture/008-workspace-read-models.md)
- [Orders workspace](../../docs/orders-workspace.md)
- [Needs you](../../docs/needs-you.md)
