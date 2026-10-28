# @luma/api-contract

HTTP contracts for Luma: request and response schemas, the typed client and OpenAPI generation.

Keep transport schemas here; domain rules and database access belong to the owning backend packages. Change a contract, its server handler and its consuming clients together, then run `pnpm --filter @luma/api-contract generate:openapi` to regenerate the committed OpenAPI document.

The root export is generated from the files in `src` and the route groups in `src/domains`. After adding or removing a schema module or group, run `pnpm --filter @luma/api-contract generate:index`. A test rejects a stale `src/generated.ts`.

Exports point to compiled `dist` output, so consumers see source changes only after a build or the package's `dev` watch.

## Public entry points

- `@luma/api-contract` — schemas and `apiContract`.
- `@luma/api-contract/client` — typed client with response validation.
- `@luma/api-contract/openapi` — server and tooling only, so schema generation stays out of browser bundles.

## Further reading

- [API](../../docs/api.md)
- [Package boundaries and runtime composition](../../docs/architecture/005-domain-packages-and-runtimes.md)
