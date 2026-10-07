# @luma/audit

Defines audit entries and the append-only, tenant-scoped audit log.

Each append runs in its own tenant transaction. Appends are idempotent by event key: an exact replay is accepted, and reusing a key with different content fails. Keep the business decision that produces an event in its owning domain; this package records the evidence.

## Public entry points

- `@luma/audit`
- `@luma/audit/composition`

## Further reading

- [Execution](../../docs/execution.md)
- [Package boundaries and runtime composition](../../docs/architecture/005-domain-packages-and-runtimes.md)
