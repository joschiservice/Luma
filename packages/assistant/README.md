# @luma/assistant

Answers workspace questions (Ask Luma) with a bounded model loop over read-only tools.

## Responsibilities

Owns the tool registry, the model ↔ tool loop, its budgets and citation resolution. Tools call
owner read services with the asking member's freshly checked context; the assistant never writes
and has no tables. Model routing and data policy enforcement belong to the platform gateway.

## Public entry points

Import through these package exports. Private source paths are not supported across package boundaries.

- `@luma/assistant` — [source](./src/index.ts).
- `@luma/assistant/composition` — [source](./src/composition.ts).
- `@luma/assistant/http` — [source](./src/http.ts).

## Workspace dependencies

[@luma/api-contract](../api-contract/README.md), [@luma/exceptions](../exceptions/README.md), [@luma/identity](../identity/README.md), [@luma/platform](../platform/README.md), [@luma/read-models](../read-models/README.md).

## Development

Run commands from the repository root after installing workspace dependencies.

```sh
pnpm exec turbo run build --filter=@luma/assistant...
pnpm exec turbo run typecheck --filter=@luma/assistant
pnpm exec turbo run test --filter=@luma/assistant
```

## Further reading

- [Ask Luma assistant](../../docs/assistant.md)
- [Model gateway](../../docs/model-gateway.md#assistant-profile)
