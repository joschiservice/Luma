# @luma/commerce-ingestion

Coordinates provider source records into canonical order and inventory projections.

Ingestion crosses domain boundaries only through the owners' public contracts; orders and inventory keep writing their own tables. Owner transactions are idempotent, and replay resumes after a projection fails partway through. Provider transport stays in connections and the apps.

## Further reading

- [Canonical commerce model](../../docs/architecture/002-canonical-commerce-model.md)
- [Commerce projections](../../docs/commerce-projections.md)
- [Package boundaries and runtime composition](../../docs/architecture/005-domain-packages-and-runtimes.md)
