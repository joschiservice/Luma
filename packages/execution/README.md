# @luma/execution

Admits and executes actions using policy decisions, tenant authorization, durable execution records, and audit evidence.

## Responsibilities

Effects are supplied through a capability registry. Preserve idempotency and uncertain-write reconciliation. Interpreted playbook steps receive bound, reference-only admission rather than unrestricted execution or provisioning access.

## Public entry points

Import through these package exports. Private source paths are not supported across package boundaries.

- `@luma/execution` — [source](./src/index.ts).
- `@luma/execution/composition` — [source](./src/composition.ts).

## Workspace dependencies

[@luma/audit](../audit/README.md), [@luma/connections](../connections/README.md), [@luma/identity](../identity/README.md), [@luma/platform](../platform/README.md), [@luma/policies](../policies/README.md).

## Development

Run commands from the repository root after installing workspace dependencies.

```sh
pnpm exec turbo run build --filter=@luma/execution...
pnpm exec turbo run typecheck --filter=@luma/execution
pnpm exec turbo run test --filter=@luma/execution
```

Use `pnpm test` for cross-package integration coverage, including the application-runtime tests backed by disposable PostgreSQL.

## Further reading

- [Engineering guide](../../docs/execution.md)
- [Package boundaries and runtime composition](../../docs/architecture/005-domain-packages-and-runtimes.md)
