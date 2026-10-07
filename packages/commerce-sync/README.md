# @luma/commerce-sync

Imports connected commerce history, keeps it current and reconciles it against each source.

Owns sync streams (one per connection and record type), their checkpoints and runs, the import ledger, and requests to link or unlink source SKUs and locations. It reads through installed connection capabilities, projects through commerce-ingestion and stores customer profiles through customers. It never writes to a source.

## Public entry points

- `@luma/commerce-sync`
- `@luma/commerce-sync/composition`
- `@luma/commerce-sync/http`

## Further reading

- [Commerce sync](../../docs/commerce-sync.md)
